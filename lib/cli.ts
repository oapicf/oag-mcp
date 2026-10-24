"use strict";
/**
 * oag-mcp command-line interface.
 *
 * @module cli
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import bag, { type CommandArg } from "bagofcli";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import { OagMcpError, formatCliError } from "./errors.js";
import { type LogLevel, Logs, type LoggingOptions } from "./logger.js";
import { type RunningServer, serve } from "./runtime/serve.js";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build logging options from CLI flags and an optional config section.
 * Values are already validated: flags by bagofcli (`choices` in
 * conf/commands.json), the config section by its zod schema.
 *
 * @private
 */
function _loggingOptions(
  args: CommandArg,
  fromConfig: LoggingOptions = {},
): LoggingOptions {
  return {
    level: (args.logLevel as LogLevel | undefined) ?? fromConfig.level,
    format:
      (args.logFormat as "json" | "pretty" | undefined) ?? fromConfig.format,
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
 * `serve` action. bagofcli has already validated every flag against
 * conf/commands.json (required inputs, allowed values, the port range, no
 * positional arguments) before calling it.
 *
 * @private
 */
async function _serve(args: CommandArg): Promise<void> {
  let logs: Logs | undefined;
  try {
    const transport =
      (args.transport as "stdio" | "streamable-http" | undefined) ?? "stdio";
    const { config, baseDir } = loadRuntimeConfig(
      args.config as string | undefined,
    );
    if (args.port !== undefined) {
      config.http.port = Number(args.port);
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
      sdkLayout: args.sdkLayout as "auto" | "source" | "compiled" | undefined,
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
      serve: { action: (args: CommandArg) => void _serve(args) },
    },
  };
  bag.command(DIRNAME, actions);
}

const exports = {
  exec,
};

export { exports as default };
