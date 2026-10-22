"use strict";
/**
 * oag-mcp command-line interface.
 *
 * @module cli
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import bag from "bagofcli";

import { build } from "./build/build.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { OagMcpError, formatCliError } from "./errors.js";
import {
  LOG_LEVELS,
  type LogLevel,
  Logs,
  type LoggingOptions,
} from "./logging/logger.js";
import { serve } from "./runtime/serve.js";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

/** Options parsed by bagofcli/commander. */
type CommandArgs = Record<string, unknown> & { args?: string[] };

/**
 * Build logging options from CLI flags and an optional config section.
 *
 * @private
 */
function _loggingOptions(
  args: CommandArgs,
  fromConfig: LoggingOptions = {},
): LoggingOptions {
  const level = (args.logLevel as string | undefined) ?? fromConfig.level;
  if (level && !(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new OagMcpError(
      "CLI_ARGS_INVALID",
      `--log-level must be one of ${LOG_LEVELS.join(", ")}`,
    );
  }
  const format = (args.logFormat as string | undefined) ?? fromConfig.format;
  if (format && format !== "json" && format !== "pretty") {
    throw new OagMcpError(
      "CLI_ARGS_INVALID",
      "--log-format must be json or pretty",
    );
  }
  return {
    level: level as LogLevel | undefined,
    format: format as "json" | "pretty" | undefined,
    file: (args.logFile as string | undefined) ?? fromConfig.file,
    auditFile:
      (args.auditLogFile as string | undefined) ?? fromConfig.auditFile,
    auditFailClosed:
      Boolean(args.auditFailClosed) || Boolean(fromConfig.auditFailClosed),
  };
}

/**
 * Parse `k=v,k2=v2`.
 *
 * @private
 */
function _parseOptions(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        `Invalid --oag-options entry "${part}" (expected key=value)`,
      );
    }
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

/**
 * Report a command failure and exit.
 *
 * @private
 */
function _fail(logs: Logs | undefined, command: string, err: unknown): never {
  logs?.op("error", "cli.command.failed", {
    command,
    errorCode: err instanceof OagMcpError ? err.code : "UNEXPECTED",
    outcome: "failure",
  });
  logs?.flush();
  process.stderr.write(`${formatCliError(err)}\n`);
  process.exit(1);
}

/**
 * `build` action.
 *
 * @private
 */
async function _build(args: CommandArgs): Promise<void> {
  let logs: Logs | undefined;
  try {
    logs = new Logs(_loggingOptions(args));
    logs.op("info", "cli.command.started", { command: "build" });
    for (const required of ["spec", "out"]) {
      if (!args[required]) {
        throw new OagMcpError("CLI_ARGS_INVALID", `--${required} is required`, {
          hint: "Run `oag-mcp build --help` for usage.",
        });
      }
    }
    const backend = (args.oagBackend as string | undefined) ?? "java";
    if (backend !== "java" && backend !== "docker") {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        "--oag-backend must be java or docker",
      );
    }
    const layout = (args.sdkLayout as string | undefined) ?? "auto";
    if (!["auto", "source", "compiled"].includes(layout)) {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        "--sdk-layout must be auto, source or compiled",
      );
    }
    if (
      !args.generateSdk &&
      (args.oagVersion || args.oagBackend || args.oagJar || args.oagOptions)
    ) {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        "--oag-version, --oag-backend, --oag-jar and --oag-options apply only with --generate-sdk",
      );
    }
    const result = await build({
      spec: String(args.spec),
      sdk: args.sdk as string | undefined,
      generateSdk: Boolean(args.generateSdk),
      out: String(args.out),
      oagVersion: args.oagVersion as string | undefined,
      oagBackend: backend,
      oagJar: args.oagJar as string | undefined,
      oagOptions: _parseOptions(args.oagOptions as string | undefined),
      sdkLayout: layout as "auto" | "source" | "compiled",
      sdkOagVersion: args.sdkOagVersion as string | undefined,
      allowUntestedOagVersion: Boolean(args.allowUntestedOagVersion),
      installDependencies: args.install !== false,
      verifyWithDeno: !args.skipVerify,
      force: Boolean(args.force),
      logs,
    });
    logs.op("info", "cli.command.completed", {
      command: "build",
      outcome: "success",
    });
    logs.flush();
    const m = result.manifest;
    const lines = [
      `Built ${m.api.title} ${m.api.version} → ${result.outDir}`,
      `  SDK: typescript-fetch, OpenAPI Generator ${m.target.oagVersion} (${m.target.sdkLayout}, ${m.inputs.sdk.kind})`,
      `  Methods: ${result.records.length} across ${new Set(result.records.map((r) => r.className)).size} API classes`,
      `  Build ID: ${m.buildId}`,
      ...result.warnings.map((w) => `  Warning: ${w}`),
      `Run: oag-mcp serve ${path.relative(process.cwd(), result.outDir) || "."} --transport stdio`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } catch (err) {
    _fail(logs, "build", err);
  }
}

/**
 * `serve` action.
 *
 * @private
 */
async function _serve(args: CommandArgs): Promise<void> {
  let logs: Logs | undefined;
  try {
    const artifact = args.args?.[0];
    if (!artifact) {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        "Usage: oag-mcp serve <artifact-dir> [--transport stdio|streamable-http]",
      );
    }
    const transport = (args.transport as string | undefined) ?? "stdio";
    if (transport !== "stdio" && transport !== "streamable-http") {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        "--transport must be stdio or streamable-http",
        {
          hint: "Legacy HTTP+SSE is not supported; use streamable-http.",
        },
      );
    }
    const { config, baseDir } = loadRuntimeConfig(
      args.config as string | undefined,
    );
    if (args.port !== undefined) {
      const port = Number(args.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new OagMcpError(
          "CLI_ARGS_INVALID",
          "--port must be an integer between 0 and 65535",
        );
      }
      config.http.port = port;
    }
    if (args.host) {
      config.http.host = String(args.host);
    }
    if (args.path) {
      config.http.path = String(args.path);
    }
    logs = new Logs(_loggingOptions(args, config.logging));
    logs.op("info", "cli.command.started", { command: "serve", transport });
    const running = await serve({
      artifactDir: artifact,
      transport,
      config,
      configBaseDir: baseDir,
      logs,
    });
    if (running.url) {
      process.stderr.write(`oag-mcp listening on ${running.url}\n`);
    }
    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing) {
        return;
      }
      closing = true;
      logs?.op("info", "server.shutdown_requested", { signal });
      try {
        await running.close();
      } finally {
        logs?.op("info", "cli.command.completed", {
          command: "serve",
          outcome: "success",
        });
        logs?.flush();
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    _fail(logs, "serve", err);
  }
}

/**
 * Execute the oag-mcp CLI.
 */
function exec(): void {
  const actions = {
    commands: {
      build: { action: (args: CommandArgs) => void _build(args) },
      serve: { action: (args: CommandArgs) => void _serve(args) },
    },
  };
  bag.command(DIRNAME, actions);
}

const exports = {
  exec,
};

export { exports as default };
