"use strict";
/**
 * Structured logging with Pino.
 *
 * Two event categories are produced, distinguished by the stable
 * `logCategory` field rather than by severity or logger name:
 *
 * - `operational`: lifecycle, builds, transports, performance, failures.
 *   Filtered by the configurable operational log level.
 * - `security_audit`: authentication, authorisation, credential handling and
 *   policy enforcement. Always recorded at `info` or above, independent of the
 *   operational level, and never sampled.
 *
 * Every record carries `event` (stable name) and `logCategory`. Destinations
 * are synchronous file descriptors so that a failing audit destination is
 * detected immediately; with fail-closed enabled, callers must refuse
 * execution while auditing is unavailable.
 *
 * @module logging/logger
 */
import crypto from "node:crypto";
import fs from "node:fs";

import pino, { type Logger as PinoLogger } from "pino";
import pinoPretty from "pino-pretty";

import { oagMcpName, oagMcpVersion } from "../util/version.js";
import { boundValue, secrets } from "./redact.js";

/** An operational log level: one of pino's levels, or `silent`. */
export type LogLevel = pino.LevelWithSilent;

/**
 * Operational log levels accepted by the CLI and configuration, taken from
 * pino: its levels from most to least severe, then `silent`.
 */
export const LOG_LEVELS: readonly LogLevel[] = [
  ...Object.entries(pino.levels.values)
    .sort(([, a], [, b]) => b - a)
    .map(([label]) => label as pino.Level),
  "silent",
];

/** Log event categories. */
export type LogCategory = "operational" | "security_audit";

/** Logging configuration. */
export interface LoggingOptions {
  /** Operational level; audit records ignore it. */
  level?: LogLevel;
  /** Output format for stderr destinations. Files are always JSON. */
  format?: "json" | "pretty";
  /** Operational destination: a path, `stderr` or `fd:N`. Default stderr. */
  file?: string;
  /** Audit destination: a path, `stderr` or `fd:N`. Default stderr. */
  auditFile?: string;
  /** Refuse execute calls while audit records cannot be written. */
  auditFailClosed?: boolean;
  /** Server instance identifier included in every record (default: random). */
  instanceId?: string;
}

/** Context fields that may be attached to any record. */
export interface LogContext {
  requestId?: string;
  executionId?: string;
  callId?: string;
  transport?: string;
  principalId?: string;
  [key: string]: unknown;
}

/**
 * A synchronous writer over a file descriptor that records failures instead
 * of throwing, and reports them to stderr without going through the logger.
 */
class SyncFdWriter {
  failures = 0;
  private reported = 0;

  constructor(
    private readonly fd: number,
    private readonly label: string,
  ) {}

  write(chunk: string): boolean {
    try {
      fs.writeSync(this.fd, chunk);
      return true;
    } catch (err) {
      this.failures++;
      // Report directly to stderr; never recurse into the logger.
      if (this.reported < 3) {
        this.reported++;
        try {
          fs.writeSync(
            2,
            `${JSON.stringify({
              time: new Date().toISOString(),
              level: "error",
              service: oagMcpName(),
              logCategory: "operational",
              event: "logging.destination_failed",
              outcome: "failure",
              destination: this.label,
              errorCode: (err as NodeJS.ErrnoException).code ?? "UNKNOWN",
            })}\n`,
          );
        } catch {
          // stderr itself is unavailable; nothing more can be done.
        }
      }
      return false;
    }
  }

  flush(): void {
    try {
      fs.fsyncSync(this.fd);
    } catch {
      // fsync is unsupported on pipes and ttys.
    }
  }
}

/**
 * Open a destination specifier.
 *
 * @param {String} spec - `stderr`, `fd:N` or a file path
 * @return {Object} { fd, label, isStderr }
 * @private
 */
function _openDestination(spec: string | undefined): {
  fd: number;
  label: string;
  isStderr: boolean;
  openError?: string;
} {
  if (!spec || spec === "stderr") {
    return { fd: 2, label: "stderr", isStderr: true };
  }
  if (spec === "stdout") {
    throw new Error(
      "Logging to stdout is not allowed; stdout is reserved for MCP protocol traffic",
    );
  }
  const fdMatch = /^fd:(\d+)$/.exec(spec);
  if (fdMatch) {
    const fd = parseInt(fdMatch[1], 10);
    if (fd === 1) {
      throw new Error(
        "Logging to fd:1 (stdout) is not allowed; stdout is reserved for MCP protocol traffic",
      );
    }
    return { fd, label: spec, isStderr: fd === 2 };
  }
  try {
    const fd = fs.openSync(spec, "a", 0o600);
    return { fd, label: "file", isStderr: false };
  } catch (err) {
    return {
      fd: -1,
      label: "file",
      isStderr: false,
      openError: (err as NodeJS.ErrnoException).code ?? "OPEN_FAILED",
    };
  }
}

/**
 * Build a pino logger writing to a destination.
 *
 * Redaction is done by the `log` formatter: {@link boundValue} censors
 * credential key names at any depth (case-insensitively), scrubs registered
 * secret values and credential-looking text, and bounds every record. Pino's
 * path-based `redact` option is not used; it would only repeat that for a
 * fixed set of case-sensitive paths.
 *
 * @private
 */
function _buildPino(
  level: string,
  dest: { fd: number; isStderr: boolean },
  writer: SyncFdWriter,
  format: "json" | "pretty",
  base: Record<string, unknown>,
): PinoLogger {
  const opts: pino.LoggerOptions = {
    level,
    base,
    messageKey: "message",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label, severity: label.toUpperCase() }),
      log: (obj) => boundValue(obj, { maxDepth: 5 }) as Record<string, unknown>,
    },
  };
  if (format === "pretty" && dest.isStderr) {
    const stream = pinoPretty({
      destination: 2,
      sync: true,
      colorize: Boolean(process.stderr.isTTY),
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "service,version,severity",
      messageKey: "message",
      messageFormat: "[{logCategory}] {event} {outcome}",
    });
    return pino(opts, stream);
  }
  return pino(opts, writer);
}

/**
 * oag-mcp logger facade over two pino instances.
 */
export class Logs {
  private readonly opLogger: PinoLogger;
  private readonly auditLogger: PinoLogger;
  private readonly opWriter: SyncFdWriter;
  private readonly auditWriter: SyncFdWriter;
  private readonly context: LogContext;
  private readonly state: { auditOpenFailed: boolean };
  readonly failClosed: boolean;

  /**
   * @param {Object} [opts] - logging options
   * @param {Object} [shared] - internal: shared state for child loggers
   */
  constructor(
    opts: LoggingOptions = {},
    shared?: {
      opLogger: PinoLogger;
      auditLogger: PinoLogger;
      opWriter: SyncFdWriter;
      auditWriter: SyncFdWriter;
      context: LogContext;
      state: { auditOpenFailed: boolean };
      failClosed: boolean;
    },
  ) {
    if (shared) {
      this.opLogger = shared.opLogger;
      this.auditLogger = shared.auditLogger;
      this.opWriter = shared.opWriter;
      this.auditWriter = shared.auditWriter;
      this.context = shared.context;
      this.state = shared.state;
      this.failClosed = shared.failClosed;
      return;
    }
    const format = opts.format ?? "json";
    const base: Record<string, unknown> = {
      service: oagMcpName(),
      version: oagMcpVersion(),
    };
    base.instanceId = opts.instanceId ?? `inst_${crypto.randomUUID()}`;
    const opDest = _openDestination(opts.file);
    const auditDest = _openDestination(opts.auditFile);
    this.opWriter = new SyncFdWriter(opDest.fd, `operational:${opDest.label}`);
    this.auditWriter = new SyncFdWriter(
      auditDest.fd,
      `security_audit:${auditDest.label}`,
    );
    this.state = { auditOpenFailed: Boolean(auditDest.openError) };
    this.failClosed = Boolean(opts.auditFailClosed);
    this.context = {};
    this.opLogger = _buildPino(
      opts.level ?? "info",
      opDest,
      this.opWriter,
      format,
      { ...base },
    );
    // Audit records are never filtered by the operational level.
    this.auditLogger = _buildPino("info", auditDest, this.auditWriter, format, {
      ...base,
    });
    if (opDest.openError) {
      fs.writeSync(
        2,
        `${JSON.stringify({ level: "error", logCategory: "operational", event: "logging.destination_open_failed", destination: "operational", errorCode: opDest.openError })}\n`,
      );
    }
    if (auditDest.openError) {
      this.auditWriter.failures++;
      fs.writeSync(
        2,
        `${JSON.stringify({ level: "error", logCategory: "operational", event: "logging.destination_open_failed", destination: "security_audit", errorCode: auditDest.openError, failClosed: this.failClosed })}\n`,
      );
    }
  }

  /**
   * Create a child logger with additional context fields.
   *
   * @param {Object} ctx - context fields such as requestId
   * @return {Logs} child logger sharing destinations
   */
  child(ctx: LogContext): Logs {
    return new Logs(
      {},
      {
        opLogger: this.opLogger,
        auditLogger: this.auditLogger,
        opWriter: this.opWriter,
        auditWriter: this.auditWriter,
        context: { ...this.context, ...ctx },
        state: this.state,
        failClosed: this.failClosed,
      },
    );
  }

  /** Context fields attached to this logger. */
  get ctx(): LogContext {
    return { ...this.context };
  }

  /**
   * Record an operational event.
   *
   * @param {String} level - pino level
   * @param {String} event - stable event name, e.g. "server.started"
   * @param {Object} [fields] - structured context (never secrets or bodies)
   * @param {String} [message] - optional human message
   */
  op(
    level: pino.Level,
    event: string,
    fields: Record<string, unknown> = {},
    message?: string,
  ): void {
    this.opLogger[level](
      { ...this.context, ...fields, logCategory: "operational", event },
      message ?? event,
    );
  }

  /**
   * Record a security audit event. Audit records bypass the operational
   * level filter and are never sampled.
   *
   * @param {String} event - stable event name, e.g. "authorization.denied"
   * @param {String} outcome - "success", "failure", "allowed", "denied", ...
   * @param {Object} [fields] - identifiers, policy ids and reason codes only
   * @param {String} [level] - "info" (default), "warn" or "error"
   * @return {Boolean} whether the record was written successfully
   */
  audit(
    event: string,
    outcome: string,
    fields: Record<string, unknown> = {},
    level: "info" | "warn" | "error" = "info",
  ): boolean {
    const before = this.auditWriter.failures;
    this.auditLogger[level](
      {
        ...this.context,
        ...fields,
        logCategory: "security_audit",
        event,
        outcome,
      },
      event,
    );
    return this.auditWriter.failures === before && !this.state.auditOpenFailed;
  }

  /**
   * Whether the audit destination has failed at least once.
   *
   * @return {Boolean} true when healthy
   */
  get auditHealthy(): boolean {
    return this.auditWriter.failures === 0 && !this.state.auditOpenFailed;
  }

  /**
   * Whether execution must be refused because auditing is required
   * (fail-closed) but unavailable.
   *
   * @return {Boolean} true when execution must be refused
   */
  auditBlocksExecution(): boolean {
    return this.failClosed && !this.auditHealthy;
  }

  /** Flush destinations, e.g. on graceful shutdown. */
  flush(): void {
    try {
      this.opLogger.flush();
      this.auditLogger.flush();
    } catch {
      // Best effort.
    }
    this.opWriter.flush();
    this.auditWriter.flush();
  }
}

/** Register a secret with the global scrubber (re-exported for callers). */
export function registerSecret(value: string | undefined | null): void {
  secrets.add(value);
}
