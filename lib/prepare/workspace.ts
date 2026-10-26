"use strict";
/**
 * The private preparation workspace: a temporary directory owned by one
 * oag-mcp process that holds the prepared SDK bundle, declarations and the
 * sandbox runner for the lifetime of the server. Users never manage it: it
 * is removed on shutdown and on start-up failure, and stale workspaces of
 * processes that have died are swept on start-up.
 *
 * @module prepare/workspace
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Logs } from "../logging/logger.js";
import type { MethodRecord } from "../types.js";

/** Prefix of workspace directory names under the temporary directory. */
export const WORKSPACE_PREFIX = "oag-mcp-ws-";

/** Owner marker written into every workspace. */
const OWNER_FILE = ".oag-mcp-owner.json";

/** Relative paths inside a workspace. */
export const WORKSPACE_PATHS = {
  bundle: "sdk/sdk.bundle.js",
  types: "sdk/types",
  binding: "sdk/sdk-binding.d.ts",
  tsLib: "sdk/ts-lib",
  runner: "executor/runner.js",
  /** Extracted SDK archives. */
  input: "input",
  /** Generated entry shims for CommonJS SDKs. */
  shim: "shim",
} as const;

/** Workspaces of this process not yet removed (for the exit safety net). */
const LIVE = new Set<string>();
let exitHookInstalled = false;

/**
 * Last-resort synchronous removal when the process exits without a graceful
 * shutdown; anything left is swept by the next start-up.
 *
 * @private
 */
function _onExit(): void {
  for (const dir of LIVE) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Swept by the next start-up.
    }
  }
  LIVE.clear();
}

/** A private workspace directory. */
export interface Workspace {
  dir: string;
  /** Remove the workspace; never throws. Returns whether it succeeded. */
  cleanup(): boolean;
}

/**
 * Whether a process exists.
 *
 * @private
 */
function _alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove workspaces left behind by oag-mcp processes on this host that no
 * longer exist (e.g. killed with SIGKILL). Only directories carrying an
 * owner marker for a dead process are removed.
 *
 * @param {String} root - parent directory of workspaces
 * @param {Object} logs - logs
 * @return {Number} number of workspaces removed
 */
export function sweepStaleWorkspaces(root: string, logs: Logs): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(WORKSPACE_PREFIX)) {
      continue;
    }
    const dir = path.join(root, name);
    try {
      const owner = JSON.parse(
        fs.readFileSync(path.join(dir, OWNER_FILE), "utf8"),
      ) as { pid?: number; hostname?: string };
      if (
        typeof owner.pid !== "number" ||
        owner.hostname !== os.hostname() ||
        _alive(owner.pid)
      ) {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Not ours, unreadable or concurrently removed: leave it alone.
    }
  }
  if (removed > 0) {
    logs.op("info", "prepare.workspace.stale_removed", { count: removed });
  }
  return removed;
}

/**
 * Create a private workspace (mode 0700) under `root`.
 *
 * @param {Object} opts - options
 * @param {String} [opts.root] - parent directory, default: OS temp directory
 * @param {Object} opts.logs - logs
 * @return {Object} workspace
 */
export function createWorkspace(opts: {
  root?: string;
  logs: Logs;
}): Workspace {
  const root = path.resolve(opts.root ?? os.tmpdir());
  fs.mkdirSync(root, { recursive: true });
  sweepStaleWorkspaces(root, opts.logs);
  const dir = fs.mkdtempSync(path.join(root, WORKSPACE_PREFIX));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(
    path.join(dir, OWNER_FILE),
    JSON.stringify({ pid: process.pid, hostname: os.hostname() }),
  );
  LIVE.add(dir);
  if (!exitHookInstalled) {
    process.once("exit", _onExit);
    exitHookInstalled = true;
  }
  let removed = false;
  const cleanup = (): boolean => {
    if (removed) {
      return true;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      removed = true;
      LIVE.delete(dir);
      opts.logs.op("debug", "prepare.workspace.removed", {
        outcome: "success",
      });
      return true;
    } catch (err) {
      opts.logs.op("warn", "prepare.workspace.cleanup_failed", {
        error: (err as NodeJS.ErrnoException).code ?? (err as Error).name,
        outcome: "failure",
      });
      return false;
    }
  };
  return { dir, cleanup };
}

/**
 * Generate the TypeScript declaration of the `sdk` binding.
 *
 * @param {Array} records - method records
 * @return {String} declaration source
 */
export function bindingDeclaration(records: MethodRecord[]): string {
  const byClass = new Map<string, string[]>();
  for (const r of records) {
    byClass.set(r.className, [
      ...(byClass.get(r.className) ?? []),
      r.methodName,
    ]);
  }
  const lines = [
    "// Generated by oag-mcp. Declares the `sdk` binding available to execute code.",
    'import type * as __sdk from "./types/index";',
    "",
    "declare global {",
    "  /**",
    "   * SDK binding provided by oag-mcp: `sdk.<ApiClass>.<method>(...)` calls the",
    "   * generated typescript-fetch SDK. Base URL and credentials are configured",
    "   * by the server; do not pass them.",
    "   */",
    "  const sdk: {",
  ];
  for (const [cls, methods] of [...byClass.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const names = methods
      .sort()
      .map((m) => JSON.stringify(m))
      .join(" | ");
    lines.push(`    readonly ${cls}: Pick<__sdk.${cls}, ${names}>;`);
  }
  lines.push("  };", "}", "", "export {};", "");
  return lines.join("\n");
}
