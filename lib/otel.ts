"use strict";
/**
 * OpenTelemetry representation of operational log records.
 *
 * Operational records follow the OpenTelemetry Logs Data Model: one JSON
 * object per line with the data model's field names (`Timestamp`,
 * `SeverityText`, `SeverityNumber`, `EventName`, `Body`, `Resource`,
 * `InstrumentationScope`, `Attributes`).
 *
 * Attribute names follow the OpenTelemetry semantic conventions
 * ({@link OTEL_SEMCONV_VERSION}), including the Model Context Protocol
 * conventions. Attributes the conventions do not define are prefixed with
 * the `oag_mcp.` namespace, as the conventions recommend.
 *
 * Call sites log camelCase fields; {@link toOtelAttributes} maps them.
 *
 * @module logging/otel
 */
import type pino from "pino";

/** Version of the OpenTelemetry semantic conventions followed. */
export const OTEL_SEMCONV_VERSION = "1.44.0";

/** Namespace for attributes that the semantic conventions do not define. */
export const OAG_MCP_NAMESPACE = "oag_mcp";

/** `SeverityNumber` of each pino level (OpenTelemetry Logs Data Model). */
export const SEVERITY_NUMBER: Readonly<Record<pino.Level, number>> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

/**
 * Fields whose OpenTelemetry semantic convention attribute differs from the
 * default `oag_mcp.<snake_case>` name.
 */
const ATTRIBUTES: Readonly<Record<string, string>> = {
  // Correlation identifiers specific to oag-mcp.
  requestId: "oag_mcp.request.id",
  executionId: "oag_mcp.execution.id",
  prepareId: "oag_mcp.prepare.id",
  // The authenticated caller.
  principalId: "enduser.id",
  clientAddress: "client.address",
  clientPort: "client.port",
  // Model Context Protocol.
  mcpSessionId: "mcp.session.id",
  jsonrpcRequestId: "jsonrpc.request.id",
  toolName: "gen_ai.tool.name",
  // HTTP calls to the upstream API.
  httpMethod: "http.request.method",
  status: "http.response.status_code",
  pathTemplate: "url.template",
  responseBytes: "http.response.body.size",
  // The address the HTTP transport listens on.
  host: "server.address",
  port: "server.port",
  // Error classification.
  error: "error.type",
  errorCode: "error.type",
  errorType: "error.type",
};

/**
 * Convert a camelCase field name to snake_case.
 *
 * @param {String} name - field name, e.g. "startupDurationMs"
 * @return {String} snake_case name, e.g. "startup_duration_ms"
 * @private
 */
function _snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * The attribute name for a field: its semantic convention attribute, or
 * `oag_mcp.<snake_case>`.
 *
 * @param {String} field - camelCase field name
 * @return {String} attribute name
 */
export function otelAttributeName(field: string): string {
  return ATTRIBUTES[field] ?? `${OAG_MCP_NAMESPACE}.${_snake(field)}`;
}

/**
 * Map logged fields to OpenTelemetry attributes.
 *
 * - `transport` becomes `network.transport` (`pipe` for stdio, `tcp` for
 *   Streamable HTTP, with `network.protocol.name: http`), as the MCP
 *   conventions describe.
 * - `toolName` also sets `mcp.method.name: tools/call` and
 *   `gen_ai.operation.name: execute_tool`.
 * - Undefined values are dropped.
 *
 * @param {Object} fields - camelCase fields, already redacted and bounded
 * @return {Object} attributes keyed by attribute name
 */
export function toOtelAttributes(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (key === "transport") {
      if (value === "stdio") {
        out["network.transport"] = "pipe";
      } else if (value === "streamable-http") {
        out["network.transport"] = "tcp";
        out["network.protocol.name"] = "http";
      } else {
        out[otelAttributeName(key)] = value;
      }
      continue;
    }
    if (key === "toolName") {
      out["mcp.method.name"] = "tools/call";
      out["gen_ai.operation.name"] = "execute_tool";
    }
    out[otelAttributeName(key)] = value;
  }
  return out;
}

/**
 * `Timestamp` of a record: nanoseconds since the Unix epoch, as a string.
 *
 * @param {Number} [ms] - milliseconds since the epoch (default: now)
 * @return {String} nanoseconds since the epoch
 */
export function otelTimestamp(ms: number = Date.now()): string {
  return `${ms}000000`;
}

/** The `Resource` and `InstrumentationScope` of every operational record. */
export interface OtelSource {
  /** Resource attributes, e.g. `service.name`. */
  resource: Record<string, unknown>;
  /** Instrumentation scope name and version. */
  scope: { Name: string; Version?: string };
}

/**
 * Build a complete operational record outside the logger, for the few
 * reports written to stderr directly when a destination fails.
 *
 * @param {String} level - pino level
 * @param {String} event - event name
 * @param {Object} fields - camelCase fields (no secrets)
 * @param {Object} source - resource and scope
 * @return {Object} record
 */
export function otelRecord(
  level: pino.Level,
  event: string,
  fields: Record<string, unknown>,
  source: OtelSource,
): Record<string, unknown> {
  return {
    Timestamp: otelTimestamp(),
    SeverityText: level.toUpperCase(),
    SeverityNumber: SEVERITY_NUMBER[level],
    Resource: source.resource,
    InstrumentationScope: source.scope,
    EventName: event,
    Attributes: toOtelAttributes(fields),
    Body: event,
  };
}
