"use strict";
/**
 * Deno subprocess executor.
 *
 * Each execution runs in a fresh Deno process:
 *
 * - no `--allow-*` permissions: filesystem, network, environment,
 *   subprocess, FFI and system information access are all denied;
 * - `--no-remote --no-npm --cached-only --no-config --no-lock`: no package
 *   installation or remote imports;
 * - V8 `--disallow-code-generation-from-strings` (no eval/new Function) and
 *   a heap limit;
 * - an empty environment (only Deno bookkeeping variables pointing at a
 *   private temporary directory) and a private temporary working directory;
 * - a wall-clock timeout after which the process is killed (SIGKILL);
 * - bounded stdout, logs and result size.
 *
 * Process separation plus Deno's permission model is the boundary. It is
 * not a complete sandbox: see docs/security.md for the residual risks.
 *
 * @module executor/deno-executor
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import semver from "semver";

import { OagMcpError } from "../errors.js";
import type { Logs } from "../logger.js";
import type { OperationBinding } from "../types.js";
import { DENO_VERSION_RANGE } from "../util/version.js";
import type {
  BridgeFetchRequest,
  ExecutionError,
  ExecutionOutcome,
  ExecutionRequest,
  Executor,
  LogEntry,
} from "./types.js";

const require = createRequire(import.meta.url);

/** Resolved Deno runtime. */
export interface DenoRuntime {
  path: string;
  version: string;
  source: "configured" | "env" | "npm-package" | "path";
}

/**
 * Name of the `deno` npm package's binary package for this platform, e.g.
 * `@deno/darwin-arm64` or `@deno/linux-x64-glibc` (the same naming the
 * `deno` package's own installer uses).
 *
 * @param {String} [platform] - Node.js platform, default: this process's
 * @param {String} [arch] - Node.js architecture, default: this process's
 * @return {String} package name
 */
export function denoPlatformPackage(
  platform: string = process.platform,
  arch: string = os.arch(),
): string {
  return platform === "linux"
    ? `@deno/linux-${arch}-glibc`
    : `@deno/${platform}-${arch}`;
}

/**
 * Locate a Deno binary: configured path, OAG_MCP_DENO_PATH, the `deno` npm
 * package installed with oag-mcp, or `deno` on PATH.
 *
 * From the npm package, the binary in this platform's package
 * ({@link denoPlatformPackage}) is tried first, then the copy the `deno`
 * package's install step places in its own folder. That copy is made once,
 * for the platform that first installed it, so it can be a binary for
 * another operating system when `node_modules` is shared, e.g. between a
 * macOS host and a Linux container.
 *
 * @param {String} [configured] - configured path
 * @return {Object} runtime
 */
export function resolveDeno(configured?: string): DenoRuntime {
  const candidates: Array<{ path: string; source: DenoRuntime["source"] }> = [];
  if (configured) {
    candidates.push({ path: configured, source: "configured" });
  }
  if (process.env.OAG_MCP_DENO_PATH) {
    candidates.push({ path: process.env.OAG_MCP_DENO_PATH, source: "env" });
  }
  const exe = process.platform === "win32" ? "deno.exe" : "deno";
  for (const pkg of [denoPlatformPackage(), "deno"]) {
    try {
      const dir = path.dirname(require.resolve(`${pkg}/package.json`));
      candidates.push({ path: path.join(dir, exe), source: "npm-package" });
    } catch {
      // The optional npm package is not installed.
    }
  }
  candidates.push({ path: "deno", source: "path" });
  for (const c of candidates) {
    if (c.source !== "path" && !fs.existsSync(c.path)) {
      continue;
    }
    const res = spawnSync(c.path, ["--version"], {
      encoding: "utf8",
      env: { NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" },
    });
    if (res.status !== 0 || res.error) {
      continue;
    }
    const m = /deno (\d+\.\d+\.\d+)/.exec(res.stdout);
    if (!m) {
      continue;
    }
    const version = m[1];
    if (!semver.satisfies(version, DENO_VERSION_RANGE)) {
      throw new OagMcpError(
        "DENO_VERSION_UNSUPPORTED",
        `Deno ${version} at ${c.path} is outside the supported range ${DENO_VERSION_RANGE}`,
        {
          hint: "Install a supported Deno 2.x release or set OAG_MCP_DENO_PATH.",
        },
      );
    }
    return { path: c.path, version, source: c.source };
  }
  throw new OagMcpError(
    "DENO_NOT_FOUND",
    "No Deno runtime was found for the execute tool",
    {
      hint: "Reinstall oag-mcp so its `deno` dependency is installed, install Deno 2.x (https://deno.com) on PATH, or set OAG_MCP_DENO_PATH.",
    },
  );
}

/** Options for {@link DenoExecutor}. */
export interface DenoExecutorOptions {
  /** Preparation workspace containing executor/runner.js and sdk/. */
  workspaceDir: string;
  deno: DenoRuntime;
  logs: Logs;
}

/**
 * Executor running agent code in a restricted Deno subprocess.
 */
export class DenoExecutor implements Executor {
  readonly name = "deno-subprocess";
  private readonly runner: string;

  /**
   * @param {Object} opts - executor options
   */
  constructor(private readonly opts: DenoExecutorOptions) {
    this.runner = path.join(opts.workspaceDir, "executor", "runner.js");
  }

  /**
   * Deno command-line arguments for an execution.
   *
   * @param {Number} memoryMb - heap limit
   * @return {Array} arguments
   */
  args(memoryMb: number): string[] {
    return [
      "run",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--no-npm",
      "--cached-only",
      `--v8-flags=--max-old-space-size=${memoryMb},--disallow-code-generation-from-strings`,
      this.runner,
    ];
  }

  /**
   * Run the bundle in verification mode: load it and check every binding.
   *
   * @param {Array} bindings - operation bindings
   * @param {String} basePath - SDK base path
   */
  async verify(bindings: OperationBinding[], basePath: string): Promise<void> {
    const outcome = await this._run(
      {
        executionId: "verify",
        moduleBase64: "",
        bindings,
        basePath,
        limits: {
          timeoutMs: 20000,
          memoryMb: 128,
          maxSdkCalls: 0,
          maxResultBytes: 4096,
          maxLogBytes: 1024,
          maxLogEntries: 10,
          maxStdoutBytes: 1024 * 1024,
        },
        bridge: async () => ({
          ok: false,
          error: { type: "permission_denied", message: "verification" },
        }),
      },
      true,
    );
    if (!outcome.ok) {
      throw new OagMcpError(
        "EXECUTOR_VERIFY_FAILED",
        `The SDK bundle failed to load in Deno: ${outcome.error?.message}`,
        {
          hint: "The SDK must run without Node.js built-ins or filesystem/network access at import time.",
        },
      );
    }
  }

  /**
   * Execute prepared code.
   *
   * @param {Object} req - execution request
   * @return {Promise} outcome
   */
  execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    return this._run(req, false);
  }

  /**
   * Spawn Deno and run the protocol.
   *
   * @private
   */
  private async _run(
    req: ExecutionRequest,
    verifyOnly: boolean,
  ): Promise<ExecutionOutcome> {
    const started = Date.now();
    const logs = this.opts.logs.child({ executionId: req.executionId });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-exec-"));
    const env: Record<string, string> = {
      DENO_DIR: path.join(tmp, "deno-dir"),
      DENO_NO_UPDATE_CHECK: "1",
      DENO_NO_PROMPT: "1",
      NO_COLOR: "1",
      TMPDIR: tmp,
      HOME: tmp,
      // Deterministic date handling: typescript-fetch maps `format: date` to
      // local midnight, so pin the sandbox clock zone to UTC.
      TZ: "UTC",
    };
    if (process.platform === "win32" && process.env.SystemRoot) {
      env.SystemRoot = process.env.SystemRoot;
    }
    let child: ChildProcess;
    try {
      child = spawn(this.opts.deno.path, this.args(req.limits.memoryMb), {
        cwd: tmp,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    // Audit records about the sandbox identify its process.
    const audit: Logs["audit"] = (event, outcome, fields = {}, level) =>
      logs.audit(event, outcome, { ...fields, pid: child.pid }, level);
    const abort = new AbortController();
    let sdkCalls = 0;
    let stdoutBytes = 0;
    let stderr = "";
    let buffer = "";
    let settled = false;
    let terminated = false;
    let done: Record<string, unknown> | undefined;
    let limitError: ExecutionError | undefined;

    const kill = (reason: string, forced = true) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        if (forced && !terminated) {
          terminated = true;
          audit(
            "executor.terminated",
            "terminated",
            { reason, executor: this.name },
            "warn",
          );
        }
      }
    };

    child.stdin?.on("error", () => {
      // The sandbox may exit (or be killed) while a broker reply is pending.
    });
    const write = (msg: unknown) => {
      if (settled || !child.stdin || !child.stdin.writable) {
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      } catch {
        // ignore: the process is gone
      }
    };

    const outcome = await new Promise<ExecutionOutcome>((resolve) => {
      const finish = (o: Omit<ExecutionOutcome, "stats">) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        abort.abort();
        // The runner exits by itself after reporting; reap it if it lingers.
        setTimeout(() => kill("cleanup", false), 500).unref();
        resolve({
          ...o,
          stats: { durationMs: Date.now() - started, sdkCalls, terminated },
        });
      };

      const timer = setTimeout(() => {
        audit(
          "execution.timeout",
          "denied",
          { timeoutMs: req.limits.timeoutMs, reason: "wall_clock_timeout" },
          "warn",
        );
        kill("timeout");
        finish({
          ok: false,
          logs: [],
          logsTruncated: false,
          error: {
            type: "timeout",
            message: `Execution exceeded the ${req.limits.timeoutMs} ms time limit and was terminated`,
          },
        });
      }, req.limits.timeoutMs);

      const handleFetch = async (msg: BridgeFetchRequest) => {
        sdkCalls++;
        if (sdkCalls > req.limits.maxSdkCalls) {
          audit(
            "execution.resource_limit",
            "denied",
            { limit: "maxSdkCalls", value: req.limits.maxSdkCalls },
            "warn",
          );
          write({
            type: "fetchResult",
            rid: msg.rid,
            ok: false,
            error: {
              type: "resource_limit",
              reason: "max_sdk_calls",
              message: `More than ${req.limits.maxSdkCalls} SDK calls in one execution`,
            },
          });
          return;
        }
        let result;
        try {
          result = await req.bridge(msg, abort.signal);
        } catch (err) {
          result = {
            ok: false as const,
            error: {
              type: "executor_error" as const,
              message: `Broker failure: ${(err as Error).message}`,
            },
          };
        }
        write({ type: "fetchResult", rid: msg.rid, ...result });
      };

      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > req.limits.maxStdoutBytes) {
          limitError = {
            type: "output_limit",
            reason: "stdout_limit",
            message: `Sandbox output exceeded ${req.limits.maxStdoutBytes} bytes`,
          };
          audit(
            "execution.resource_limit",
            "denied",
            { limit: "maxStdoutBytes", value: req.limits.maxStdoutBytes },
            "warn",
          );
          kill("output_limit");
          return;
        }
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === "fetch") {
            void handleFetch(msg as unknown as BridgeFetchRequest);
          } else if (msg.type === "done" && !done) {
            done = msg;
            finish({
              ok: Boolean(msg.ok),
              result: msg.result,
              resultUndefined: Boolean(msg.resultUndefined),
              logs: Array.isArray(msg.logs) ? (msg.logs as LogEntry[]) : [],
              logsTruncated: Boolean(msg.logsTruncated),
              error: msg.error as ExecutionError | undefined,
            });
          }
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderr.length < 16384) {
          stderr += chunk.toString("utf8");
        }
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          logs: [],
          logsTruncated: false,
          error: {
            type: "executor_error",
            message: `Failed to start Deno: ${err.message}`,
          },
        });
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        if (limitError) {
          finish({
            ok: false,
            logs: [],
            logsTruncated: false,
            error: limitError,
          });
          return;
        }
        const oom = /out of memory|heap limit|Allocation failed/i.test(stderr);
        if (oom) {
          audit(
            "execution.resource_limit",
            "denied",
            { limit: "memoryMb", value: req.limits.memoryMb },
            "warn",
          );
        }
        finish({
          ok: false,
          logs: [],
          logsTruncated: false,
          error: oom
            ? {
                type: "resource_limit",
                reason: "memory_limit",
                message: `Execution exceeded the ${req.limits.memoryMb} MB memory limit`,
              }
            : {
                type: "executor_error",
                message: `Sandbox exited unexpectedly (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
              },
        });
      });
      write({
        type: "init",
        code: req.moduleBase64,
        verifyOnly,
        bindings: req.bindings.map((b) => ({
          id: b.id,
          className: b.className,
          methodName: b.methodName,
        })),
        basePath: req.basePath,
        limits: {
          maxLogBytes: req.limits.maxLogBytes,
          maxLogEntries: req.limits.maxLogEntries,
          maxResultBytes: req.limits.maxResultBytes,
        },
      });
    });
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    return outcome;
  }
}
