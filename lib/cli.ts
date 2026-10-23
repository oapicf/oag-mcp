"use strict";
/**
 * oag-mcp command-line interface.
 *
 * @module cli
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import bag from "bagofcli";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import { OagMcpError, formatCliError } from "./errors.js";
import {
  LOG_LEVELS,
  type LogLevel,
  Logs,
  type LoggingOptions,
} from "./logging/logger.js";
import { type RunningServer, serve } from "./runtime/serve.js";

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
 * `serve` action.
 *
 * @private
 */
async function _serve(args: CommandArgs): Promise<void> {
  // bagofcli invokes this action from commander.parse() and only then
  // applies the commands.json rules (e.g. `required` on --spec/--sdk) in the
  // same tick. Yield once so a rule failure exits before anything here runs:
  // no logs, no config loading, no preparation workspace.
  await new Promise<void>((resolve) => setImmediate(resolve));
  let logs: Logs | undefined;
  try {
    if (args.args && args.args.length > 0) {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        `Unexpected argument "${args.args[0]}"`,
        {
          hint: "serve takes no positional arguments; pass the inputs as options: oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk",
        },
      );
    }
    const layout = (args.sdkLayout as string | undefined) ?? "auto";
    if (!["auto", "source", "compiled"].includes(layout)) {
      throw new OagMcpError(
        "CLI_ARGS_INVALID",
        "--sdk-layout must be auto, source or compiled",
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
    // Signal handlers are installed before preparation starts. A signal
    // during start-up cancels preparation at the next stage boundary; the
    // normal failure path then removes the workspace. A second signal exits
    // immediately (the exit hook still removes the workspace, best effort).
    const state: { running?: RunningServer } = {};
    const startup = new AbortController();
    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing) {
        if (!state.running) {
          process.exit(1);
        }
        return;
      }
      closing = true;
      logs?.op("info", "server.shutdown_requested", {
        signal,
        phase: state.running ? "serving" : "starting",
      });
      if (!state.running) {
        startup.abort();
        return;
      }
      try {
        await state.running.close();
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
    const running = await serve({
      spec: String(args.spec),
      sdk: String(args.sdk),
      sdkLayout: layout as "auto" | "source" | "compiled",
      sdkOagVersion: args.sdkOagVersion as string | undefined,
      allowUntestedOagVersion: Boolean(args.allowUntestedOagVersion),
      transport,
      config,
      configBaseDir: baseDir,
      signal: startup.signal,
      logs,
    });
    state.running = running;
    if (closing) {
      // The signal arrived while the transport was starting.
      await running.close();
      logs.flush();
      process.exit(1);
    }
    if (running.url) {
      process.stderr.write(`oag-mcp listening on ${running.url}\n`);
    }
    if (transport === "stdio") {
      // The MCP client closed our stdin: shut down and remove the workspace.
      process.stdin.once("end", () => void shutdown("stdin_closed"));
    }
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
      serve: { action: (args: CommandArgs) => void _serve(args) },
    },
  };
  bag.command(DIRNAME, actions);
}

const exports = {
  exec,
};

export { exports as default };
