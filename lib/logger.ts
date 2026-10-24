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
 * are synchronous sonic-boom destinations over file descriptors, so a
 * failing audit destination is detected immediately; with fail-closed
 * enabled, callers must refuse execution while auditing is unavailable.
 *
 * @module logger
 */
import crypto from "node:crypto";
import fs from "node:fs";
import tty from "node:tty";

import pino, { type Logger as PinoLogger } from "pino";
import pinoPretty from "pino-pretty";
import sonicBoomModule, { type SonicBoomOpts } from "sonic-boom";

import { oagMcpName, oagMcpVersion } from "./util/version.js";
import { boundValue } from "./util/redact.js";

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
 * How many times in a row a write to a full, non-blocking destination
 * (typically a stderr pipe whose reader is falling behind) is retried before
 * it counts as failed. sonic-boom waits 100 ms between attempts, so this is
 * about two seconds. The count resets only when a write makes progress, so
 * once it is exhausted further writes fail fast until the reader catches up.
 */
export const MAX_WRITE_RETRIES = 20;

// sonic-boom is CommonJS (`module.exports = SonicBoom`), but its type
// definitions declare an ES default export, so TypeScript places the class one
// level deeper than it is at runtime.
const SonicBoom = sonicBoomModule as unknown as typeof sonicBoomModule.default;
type SonicBoom = InstanceType<typeof SonicBoom>;

/** Upper bound on log data held in memory while a destination is failing. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** A synchronous destination together with its failure count. */
interface TrackedDestination {
  fd: number;
  stream: SonicBoom;
  health: { failures: number };
}

/**
 * Create a synchronous sonic-boom destination over a file descriptor.
 * Failed writes are counted instead of thrown, and the first few are
 * reported to stderr directly, never through the logger.
 *
 * - Writes are synchronous, so a failing audit destination is detected during
 *   the logging call (needed for fail-closed auditing).
 * - Partial writes are completed, and a record whose write failed stays
 *   buffered (up to `MAX_BUFFERED_BYTES`) and is written, in order, once the
 *   destination recovers.
 * - A full non-blocking pipe (`EAGAIN`) is retried up to `MAX_WRITE_RETRIES`
 *   times, so a reader that never drains stderr cannot stall the server.
 *
 * sonic-boom 5 is used directly rather than through `pino.destination()`,
 * whose bundled sonic-boom 4 retries a persistent write error forever in
 * `flushSync()`; pino calls `flushSync()` after every `fatal` record.
 *
 * @param {Number} fd - file descriptor
 * @param {String} label - destination label used in failure reports
 * @return {Object} { fd, stream, health }
 * @private
 */
function _trackedDestination(fd: number, label: string): TrackedDestination {
  const health = { failures: 0 };
  let reported = 0;
  const stream = new SonicBoom({
    fd,
    sync: true,
    maxLength: MAX_BUFFERED_BYTES,
    // Supported since sonic-boom 5.0.0, not yet in its type definitions.
    maxWriteRetries: MAX_WRITE_RETRIES,
  } as SonicBoomOpts);
  const fail = (errorCode: string) => {
    health.failures++;
    if (reported < 3) {
      reported++;
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
            destination: label,
            errorCode,
          })}\n`,
        );
      } catch {
        // stderr itself is unavailable; nothing more can be done.
      }
    }
  };
  stream.on("error", (err: NodeJS.ErrnoException) =>
    fail(err.code ?? "UNKNOWN"),
  );
  stream.on("drop", () => fail("BUFFER_FULL"));
  return { fd, stream, health };
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
  tracked: TrackedDestination,
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
    // Pretty output goes through the same tracked destination, so its write
    // failures are counted too.
    const stream = pinoPretty({
      destination: tracked.stream,
      colorize: tty.isatty(dest.fd),
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "service,version,severity",
      messageKey: "message",
      messageFormat: "[{logCategory}] {event} {outcome}",
    });
    return pino(opts, stream);
  }
  return pino(opts, tracked.stream);
}

/**
 * oag-mcp logger facade over two pino instances.
 */
export class Logs {
  private readonly opLogger: PinoLogger;
  private readonly auditLogger: PinoLogger;
  private readonly opDest: TrackedDestination;
  private readonly auditDest: TrackedDestination;
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
      opDest: TrackedDestination;
      auditDest: TrackedDestination;
      context: LogContext;
      state: { auditOpenFailed: boolean };
      failClosed: boolean;
    },
  ) {
    if (shared) {
      this.opLogger = shared.opLogger;
      this.auditLogger = shared.auditLogger;
      this.opDest = shared.opDest;
      this.auditDest = shared.auditDest;
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
    this.opDest = _trackedDestination(opDest.fd, `operational:${opDest.label}`);
    this.auditDest = _trackedDestination(
      auditDest.fd,
      `security_audit:${auditDest.label}`,
    );
    this.state = { auditOpenFailed: Boolean(auditDest.openError) };
    this.failClosed = Boolean(opts.auditFailClosed);
    this.context = {};
    this.opLogger = _buildPino(
      opts.level ?? "info",
      opDest,
      this.opDest,
      format,
      { ...base },
    );
    // Audit records are never filtered by the operational level.
    this.auditLogger = _buildPino("info", auditDest, this.auditDest, format, {
      ...base,
    });
    if (opDest.openError) {
      fs.writeSync(
        2,
        `${JSON.stringify({ level: "error", logCategory: "operational", event: "logging.destination_open_failed", destination: "operational", errorCode: opDest.openError })}\n`,
      );
    }
    if (auditDest.openError) {
      this.auditDest.health.failures++;
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
        opDest: this.opDest,
        auditDest: this.auditDest,
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
    const before = this.auditDest.health.failures;
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
    return (
      this.auditDest.health.failures === before && !this.state.auditOpenFailed
    );
  }

  /**
   * Whether the audit destination has failed at least once.
   *
   * @return {Boolean} true when healthy
   */
  get auditHealthy(): boolean {
    return this.auditDest.health.failures === 0 && !this.state.auditOpenFailed;
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
    for (const { fd, stream } of [this.opDest, this.auditDest]) {
      try {
        // Retry anything still buffered after an earlier failed write.
        stream.flushSync();
      } catch {
        // The destination is still failing; it has already been counted.
      }
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync is unsupported on pipes and ttys.
      }
    }
  }
}
