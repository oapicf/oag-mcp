"use strict";
/**
 * Executor interfaces. The executor is replaceable: the MCP tools depend
 * only on {@link Executor}, never on Deno specifics, and search does not
 * depend on the executor at all.
 *
 * @module executor/types
 */
import type { OperationBinding } from "../types.js";

/** Structured execution error categories returned to agents. */
export type ExecutionErrorType =
  | "syntax_error"
  | "type_error"
  | "permission_denied"
  | "api_error"
  | "sdk_error"
  | "upstream_auth_error"
  | "upstream_unreachable"
  | "runtime_error"
  | "timeout"
  | "output_limit"
  | "resource_limit"
  | "unsupported_result"
  | "executor_error"
  | "audit_unavailable";

/** A structured execution error. */
export interface ExecutionError {
  type: ExecutionErrorType;
  name?: string;
  message: string;
  reason?: string;
  capability?: string;
  status?: number;
  body?: string;
  line?: number;
  column?: number;
  operation?: string;
  diagnostics?: Diagnostic[];
  [key: string]: unknown;
}

/** A compiler diagnostic mapped to agent code coordinates. */
export interface Diagnostic {
  line: number;
  column: number;
  code: number;
  message: string;
}

/** A captured console line. */
export interface LogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
}

/** Message sent by sandboxed code to request an HTTP call. */
export interface BridgeFetchRequest {
  rid: number;
  binding: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  bodyEncoding?: "utf8" | "base64";
}

/** Host response to a bridge fetch. */
export type BridgeFetchResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      body: string;
    }
  | { ok: false; error: ExecutionError };

/** Handles bridge fetches for one execution. */
export type BridgeHandler = (
  req: BridgeFetchRequest,
  signal: AbortSignal,
) => Promise<BridgeFetchResult>;

/** Limits applied to a single execution. */
export interface ExecutionLimits {
  timeoutMs: number;
  memoryMb: number;
  maxSdkCalls: number;
  maxResultBytes: number;
  maxLogBytes: number;
  maxLogEntries: number;
  maxStdoutBytes: number;
}

/** A prepared execution request. */
export interface ExecutionRequest {
  executionId: string;
  /** Base64 of the ES module source produced from agent code. */
  moduleBase64: string;
  bindings: OperationBinding[];
  basePath: string;
  limits: ExecutionLimits;
  bridge: BridgeHandler;
}

/** Outcome of an execution. */
export interface ExecutionOutcome {
  ok: boolean;
  result?: unknown;
  resultUndefined?: boolean;
  logs: LogEntry[];
  logsTruncated: boolean;
  error?: ExecutionError;
  stats: { durationMs: number; sdkCalls: number; terminated: boolean };
}

/** A replaceable executor. */
export interface Executor {
  readonly name: string;
  /** Verify the executor can load the SDK bundle and every binding. */
  verify(bindings: OperationBinding[], basePath: string): Promise<void>;
  /** Run one execution in isolation. */
  execute(req: ExecutionRequest): Promise<ExecutionOutcome>;
}
