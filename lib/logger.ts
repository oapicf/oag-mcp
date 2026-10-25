"use strict";
/**
 * Structured logging with Pino, in two standard formats.
 *
 * Two event categories are produced, each in the standard suited to it:
 *
 * - `operational`: lifecycle, builds, transports, performance, failures.
 *   OpenTelemetry log records (see {@link module:otel}), filtered by the
 *   configurable operational log level.
 * - `security_audit`: authentication, authorisation, credential handling and
 *   policy enforcement. OCSF events (see {@link module:ocsf}), always
 *   recorded independent of the operational level, and never sampled.
 *
 * Every record carries a stable event name: `EventName` in operational
 * records, `metadata.event_code` in audit records. Destinations are
 * synchronous sonic-boom destinations over file descriptors, so a failing
 * audit destination is detected immediately; with fail-closed enabled,
 * callers must refuse execution while auditing is unavailable.
 *
 * @module logger
 */
import crypto from "node:crypto";
import fs from "node:fs";
import tty from "node:tty";

import pino, { type Logger as PinoLogger } from "pino";
import pinoPretty, { prettyFactory } from "pino-pretty";
import sonicBoomModule, { type SonicBoomOpts } from "sonic-boom";

import {
  type AuditEvent,
  type AuditLevel,
  type AuditOutcome,
  type OcsfProduct,
  toOcsfEvent,
} from "./ocsf.js";
import {
  type OtelSource,
  SEVERITY_NUMBER,
  otelRecord,
  otelTimestamp,
  toOtelAttributes,
} from "./otel.js";
import { boundValue } from "./util/redact.js";
import { oagMcpAuthor, oagMcpName, oagMcpVersion } from "./util/version.js";

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
  transport?: string;
  principalId?: string;
  /** Address and port of a Streamable HTTP client. */
  clientAddress?: string;
  clientPort?: number;
  /** MCP session and JSON-RPC request of a tool call. */
  mcpSessionId?: string;
  jsonrpcRequestId?: string | number;
  /** MCP tool being called. */
  toolName?: string;
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

/** Depth to which logged fields are kept; deeper values are cut. */
const MAX_FIELD_DEPTH = 5;

/**
 * OpenTelemetry resource and scope of operational records.
 *
 * @param {String} [instanceId] - server instance identifier
 * @return {Object} source
 * @private
 */
function _otelSource(instanceId?: string): OtelSource {
  return {
    resource: {
      "service.name": oagMcpName(),
      "service.version": oagMcpVersion(),
      ...(instanceId ? { "service.instance.id": instanceId } : {}),
    },
    scope: { Name: `${oagMcpName()}.operational`, Version: oagMcpVersion() },
  };
}

/**
 * Write one operational record to stderr directly, never through the
 * logger, e.g. to report that a destination failed.
 *
 * @private
 */
function _reportToStderr(
  event: string,
  fields: Record<string, unknown>,
  instanceId?: string,
): void {
  try {
    fs.writeSync(
      2,
      `${JSON.stringify(otelRecord("error", event, { ...fields, outcome: "failure" }, _otelSource(instanceId)))}\n`,
    );
  } catch {
    // stderr itself is unavailable; nothing more can be done.
  }
}

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
      _reportToStderr("logging.destination_failed", {
        destination: label,
        errorCode,
      });
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
 * Local wall-clock time of a timestamp, for pretty output.
 *
 * @param {Number} ms - milliseconds since the epoch
 * @return {String} HH:MM:ss.mmm
 * @private
 */
function _localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Build the pino logger for operational records: OpenTelemetry log records
 * with the data model's field names.
 *
 * @private
 */
function _buildOperationalPino(
  level: string,
  dest: { fd: number; isStderr: boolean },
  tracked: TrackedDestination,
  format: "json" | "pretty",
  source: OtelSource,
): PinoLogger {
  const opts: pino.LoggerOptions = {
    level,
    base: { Resource: source.resource, InstrumentationScope: source.scope },
    messageKey: "Body",
    timestamp: () => `,"Timestamp":"${otelTimestamp()}"`,
    formatters: {
      level: (label) => ({
        SeverityText: label.toUpperCase(),
        SeverityNumber: SEVERITY_NUMBER[label as pino.Level],
      }),
    },
  };
  if (format === "pretty" && dest.isStderr) {
    // Pretty output goes through the same tracked destination, so its write
    // failures are counted too.
    const stream = pinoPretty({
      destination: tracked.stream,
      colorize: tty.isatty(dest.fd),
      levelKey: "SeverityText",
      timestampKey: "Timestamp",
      translateTime: false,
      ignore: "Resource,InstrumentationScope,EventName,SeverityNumber,Body",
      messageFormat: (log) => {
        const attributes = (log.Attributes ?? {}) as Record<string, unknown>;
        const outcome = attributes["oag_mcp.outcome"];
        return `[operational] ${String(log.EventName)}${outcome ? ` ${String(outcome)}` : ""}`;
      },
      customPrettifiers: {
        // `Timestamp` is in nanoseconds, which pino-pretty cannot translate.
        time: (ts) => `[${_localTime(Number(BigInt(String(ts)) / 1000000n))}]`,
      },
    });
    return pino(opts, stream);
  }
  return pino(opts, tracked.stream);
}

/**
 * Build the writer for security audit records. Each OCSF event is written
 * exactly as built, one JSON object per line; pino is not used, since it
 * would add its own level and time fields.
 *
 * @private
 */
function _buildAuditWriter(
  dest: { fd: number; isStderr: boolean },
  tracked: TrackedDestination,
  format: "json" | "pretty",
): (event: Record<string, unknown>) => void {
  if (format === "pretty" && dest.isStderr) {
    const pretty = prettyFactory({
      colorize: tty.isatty(dest.fd),
      timestampKey: "time",
      translateTime: false,
      customPrettifiers: {
        time: (ts) => `[${_localTime(Number(ts))}]`,
        // OCSF severity, e.g. "Informational", rather than a pino level.
        level: (severity) => String(severity).toUpperCase(),
      },
      levelKey: "severity",
      hideObject: true,
      messageFormat: (log) => {
        const metadata = (log.metadata ?? {}) as Record<string, unknown>;
        const detail = log.status_detail
          ? ` (${String(log.status_detail)})`
          : "";
        return `[security_audit] ${String(metadata.event_code)} ${String(log.class_name)}: ${String(log.activity_name)} ${String(log.action ?? log.status)}${detail}`;
      },
    });
    return (event) => {
      tracked.stream.write(pretty(event));
    };
  }
  return (event) => {
    tracked.stream.write(`${JSON.stringify(event)}\n`);
  };
}

/**
 * oag-mcp logger facade: a pino logger for operational records and an
 * OCSF writer for security audit records.
 */
export class Logs {
  private readonly opLogger: PinoLogger;
  private readonly writeAudit: (event: Record<string, unknown>) => void;
  private readonly opDest: TrackedDestination;
  private readonly auditDest: TrackedDestination;
  private readonly context: LogContext;
  private readonly state: { auditOpenFailed: boolean };
  private readonly product: OcsfProduct;
  readonly failClosed: boolean;

  /**
   * @param {Object} [opts] - logging options
   * @param {Object} [shared] - internal: shared state for child loggers
   */
  constructor(
    opts: LoggingOptions = {},
    shared?: {
      opLogger: PinoLogger;
      writeAudit: (event: Record<string, unknown>) => void;
      opDest: TrackedDestination;
      auditDest: TrackedDestination;
      context: LogContext;
      state: { auditOpenFailed: boolean };
      product: OcsfProduct;
      failClosed: boolean;
    },
  ) {
    if (shared) {
      this.opLogger = shared.opLogger;
      this.writeAudit = shared.writeAudit;
      this.opDest = shared.opDest;
      this.auditDest = shared.auditDest;
      this.context = shared.context;
      this.state = shared.state;
      this.product = shared.product;
      this.failClosed = shared.failClosed;
      return;
    }
    const format = opts.format ?? "json";
    const instanceId = opts.instanceId ?? `inst_${crypto.randomUUID()}`;
    this.product = {
      name: oagMcpName(),
      version: oagMcpVersion(),
      vendorName: oagMcpAuthor(),
      instanceId,
    };
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
    this.opLogger = _buildOperationalPino(
      opts.level ?? "info",
      opDest,
      this.opDest,
      format,
      _otelSource(instanceId),
    );
    // Audit records are never filtered by the operational level.
    this.writeAudit = _buildAuditWriter(auditDest, this.auditDest, format);
    if (opDest.openError) {
      _reportToStderr(
        "logging.destination_open_failed",
        { destination: "operational", errorCode: opDest.openError },
        instanceId,
      );
    }
    if (auditDest.openError) {
      this.auditDest.health.failures++;
      _reportToStderr(
        "logging.destination_open_failed",
        {
          destination: "security_audit",
          errorCode: auditDest.openError,
          failClosed: this.failClosed,
        },
        instanceId,
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
        writeAudit: this.writeAudit,
        opDest: this.opDest,
        auditDest: this.auditDest,
        context: { ...this.context, ...ctx },
        state: this.state,
        product: this.product,
        failClosed: this.failClosed,
      },
    );
  }

  /** Context fields attached to this logger. */
  get ctx(): LogContext {
    return { ...this.context };
  }

  /**
   * Record an operational event as an OpenTelemetry log record.
   *
   * Fields are redacted and bounded, then named by the OpenTelemetry
   * semantic conventions (see {@link toOtelAttributes}).
   *
   * @param {String} level - pino level
   * @param {String} event - stable event name, e.g. "server.ready"
   * @param {Object} [fields] - structured context (never secrets or bodies)
   * @param {String} [message] - optional human message (default: the event)
   */
  op(
    level: pino.Level,
    event: string,
    fields: Record<string, unknown> = {},
    message?: string,
  ): void {
    if (!this.opLogger.isLevelEnabled(level)) {
      return;
    }
    const bounded = boundValue(
      { ...this.context, ...fields },
      { maxDepth: MAX_FIELD_DEPTH },
    ) as Record<string, unknown>;
    this.opLogger[level](
      { EventName: event, Attributes: toOtelAttributes(bounded) },
      message ?? event,
    );
  }

  /**
   * Record a security audit event as an OCSF event. Audit records bypass
   * the operational level filter and are never sampled.
   *
   * @param {String} event - stable event name, e.g. "authorization.denied"
   * @param {String} outcome - "success", "failure", "allowed", "denied", ...
   * @param {Object} [fields] - identifiers, policy ids and reason codes only
   * @param {String} [level] - "info" (default), "warn" or "error"
   * @return {Boolean} whether the record was written successfully
   */
  audit(
    event: AuditEvent,
    outcome: AuditOutcome,
    fields: Record<string, unknown> = {},
    level: AuditLevel = "info",
  ): boolean {
    const before = this.auditDest.health.failures;
    const bounded = boundValue(
      { ...this.context, ...fields },
      { maxDepth: MAX_FIELD_DEPTH },
    ) as Record<string, unknown>;
    this.writeAudit({
      ...toOcsfEvent(event, outcome, level, bounded, this.product),
      message: event,
    });
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
