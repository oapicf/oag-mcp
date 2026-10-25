"use strict";
/**
 * Read oag-mcp log records in either standard format, flattened to the few
 * fields tests check.
 *
 * - Operational records are OpenTelemetry log records (`EventName`,
 *   `Attributes`).
 * - Security audit records are OCSF events (`class_uid`,
 *   `metadata.event_code`).
 */
import fs from "node:fs";

import { otelAttributeName } from "../../lib/otel.js";

type Json = Record<string, unknown>;

/** A log record of either category, flattened. */
export interface LogRecordView {
  category: "operational" | "security_audit";
  /** Stable event name. */
  event: string;
  /**
   * Operational: `oag_mcp.outcome`. Audit: the security control action
   * (`allowed`, `denied`, `modified`) when there is one, otherwise the status
   * (`success`, `failure`).
   */
  outcome?: string;
  requestId?: string;
  executionId?: string;
  principalId?: string;
  /** The record as written. */
  raw: Json;
  /**
   * A logged field by its call-site (camelCase) name, read from where the
   * standard format placed it.
   */
  get(field: string): unknown;
}

/** Where OCSF events place call-site fields other than under `unmapped`. */
const OCSF_FIELDS: Record<string, (raw: Json) => unknown> = {
  operation: (raw) => _obj(raw.api).operation ?? _obj(raw.unmapped).operation,
  policyId: (raw) => _obj(raw.policy).uid,
  reason: (raw) => raw.status_detail,
  errorCode: (raw) => raw.status_code,
  httpMethod: (raw) => _obj(raw.http_request).http_method,
};

function _obj(v: unknown): Json {
  return v && typeof v === "object" ? (v as Json) : {};
}

function _str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Flatten one record.
 *
 * @param {Object} raw - parsed JSON line
 * @return {Object} view
 */
export function viewRecord(raw: Json): LogRecordView {
  if (raw.class_uid !== undefined) {
    const metadata = _obj(raw.metadata);
    const unmapped = _obj(raw.unmapped);
    const action = _str(raw.action);
    return {
      category: "security_audit",
      event: String(metadata.event_code),
      outcome: (action ?? _str(raw.status))?.toLowerCase(),
      requestId: _str(metadata.correlation_uid),
      executionId:
        _str(_obj(_obj(raw.api).request).uid) ??
        _str(_obj(raw.process).uid) ??
        _str(unmapped.executionId),
      principalId:
        _str(_obj(_obj(raw.actor).user).uid) ??
        (raw.class_uid === 3002 ? _str(_obj(raw.user).uid) : undefined),
      raw,
      get: (field) => OCSF_FIELDS[field]?.(raw) ?? _obj(raw.unmapped)[field],
    };
  }
  const attributes = _obj(raw.Attributes);
  return {
    category: "operational",
    event: String(raw.EventName),
    outcome: _str(attributes["oag_mcp.outcome"]),
    requestId: _str(attributes["oag_mcp.request.id"]),
    executionId: _str(attributes["oag_mcp.execution.id"]),
    principalId: _str(attributes["enduser.id"]),
    raw,
    get: (field) => attributes[otelAttributeName(field)],
  };
}

/**
 * Read and flatten every record of a log file.
 *
 * @param {String} file - JSON lines file (missing means no records)
 * @return {Array} views
 */
export function readLogRecords(file: string): LogRecordView[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return parseLogRecords(fs.readFileSync(file, "utf8"));
}

/**
 * Parse and flatten JSON lines.
 *
 * @param {String} text - JSON lines
 * @return {Array} views
 */
export function parseLogRecords(text: string): LogRecordView[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => viewRecord(JSON.parse(l) as Json));
}
