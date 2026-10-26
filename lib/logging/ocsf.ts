"use strict";
/**
 * OCSF representation of security audit records.
 *
 * Every security audit record is an Open Cybersecurity Schema Framework
 * ({@link OCSF_VERSION}) event: one JSON object per line, in one of six
 * classes chosen by the oag-mcp event name (kept in `metadata.event_code`):
 *
 * | Class | Used for |
 * | --- | --- |
 * | Authentication (3002) | MCP caller authentication, upstream OAuth tokens |
 * | API Activity (6003) | the `execute` tool call and each SDK operation's authorisation |
 * | HTTP Activity (4002) | denied upstream destinations and redirects, rejected HTTP requests |
 * | Process Activity (1007) | the Deno sandbox process: limits, denied capabilities, termination |
 * | Application Lifecycle (6002) | security configuration applied, or start-up refused |
 * | Detection Finding (2004) | forged bridge messages from agent code |
 *
 * Profiles used: Date/Time (`time_dt`), Security Control (allow and deny
 * decisions), Host (`actor` where the class does not define it) and AI
 * Operation (`message_context`: the MCP tool call and session).
 *
 * Call sites log camelCase fields; {@link toOcsfEvent} places the ones OCSF
 * defines in their OCSF attribute and keeps the rest under `unmapped`.
 *
 * @module logging/ocsf
 */
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";

/** OCSF schema version followed. */
export const OCSF_VERSION = "1.9.0";

/** OCSF event classes used by oag-mcp, with the activities they use. */
const CLASSES = {
  authentication: {
    uid: 3002,
    name: "Authentication",
    category_uid: 3,
    category_name: "Identity & Access Management",
    activities: { 1: "Logon" },
  },
  api_activity: {
    uid: 6003,
    name: "API Activity",
    category_uid: 6,
    category_name: "Application Activity",
    activities: { 1: "Create", 2: "Read", 3: "Update", 4: "Delete" },
  },
  http_activity: {
    uid: 4002,
    name: "HTTP Activity",
    category_uid: 4,
    category_name: "Network Activity",
    activities: {
      1: "Connect",
      2: "Delete",
      3: "Get",
      4: "Head",
      5: "Options",
      6: "Post",
      7: "Put",
      8: "Trace",
      9: "Patch",
    },
  },
  process_activity: {
    uid: 1007,
    name: "Process Activity",
    category_uid: 1,
    category_name: "System Activity",
    activities: { 2: "Terminate" },
  },
  application_lifecycle: {
    uid: 6002,
    name: "Application Lifecycle",
    category_uid: 6,
    category_name: "Application Activity",
    activities: { 3: "Start" },
  },
  detection_finding: {
    uid: 2004,
    name: "Detection Finding",
    category_uid: 2,
    category_name: "Findings",
    activities: { 1: "Create" },
  },
} satisfies Record<
  string,
  {
    uid: number;
    name: string;
    category_uid: number;
    category_name: string;
    activities: Record<number, string>;
  }
>;

type OcsfClass = keyof typeof CLASSES;

/** OCSF `activity_id` 99 (Other): the activity is named by `activity_name`. */
const OTHER = 99;

/** API Activity's activity for each HTTP method. */
const API_ACTIVITY: Readonly<Record<string, number>> = {
  POST: 1,
  GET: 2,
  HEAD: 2,
  OPTIONS: 2,
  PUT: 3,
  PATCH: 3,
  DELETE: 4,
};

/** HTTP Activity's activity for each HTTP method. */
const HTTP_ACTIVITY: Readonly<Record<string, number>> = {
  CONNECT: 1,
  DELETE: 2,
  GET: 3,
  HEAD: 4,
  OPTIONS: 5,
  POST: 6,
  PUT: 7,
  TRACE: 8,
  PATCH: 9,
};

/** How an oag-mcp event maps to an OCSF class and activity. */
interface EventSpec {
  cls: OcsfClass;
  /** Activity id, or a source-specific name for activity 99 (Other). */
  activity: number | string;
  /** `status_id` regardless of the logged outcome. */
  statusId?: 1 | 2;
  /** `severity_id` regardless of the logged level. */
  severityId?: number;
}

type Fields = Record<string, unknown>;

/**
 * API Activity, with the activity of the SDK operation's HTTP method.
 *
 * @private
 */
function _api(f: Fields): EventSpec {
  const method = String(f.httpMethod ?? "").toUpperCase();
  return { cls: "api_activity", activity: API_ACTIVITY[method] ?? "Call" };
}

/**
 * HTTP Activity, with the activity of the request's HTTP method.
 *
 * @private
 */
function _http(f: Fields): EventSpec {
  const method = String(f.httpMethod ?? "").toUpperCase();
  return {
    cls: "http_activity",
    activity: HTTP_ACTIVITY[method] ?? (method || "Request"),
  };
}

const CONFIGURE: EventSpec = {
  cls: "application_lifecycle",
  activity: "Configure",
};
const START: EventSpec = { cls: "application_lifecycle", activity: 3 };
const LOGON: EventSpec = { cls: "authentication", activity: 1 };
const EXECUTE: EventSpec = { cls: "api_activity", activity: "Execute" };
const TERMINATE: EventSpec = {
  cls: "process_activity",
  activity: 2,
  statusId: 1,
};

/**
 * Every security audit event oag-mcp records, and its OCSF class and
 * activity. Logging an event name not listed here is a compile-time error.
 */
const EVENTS = {
  "authentication.mode_configured": () => CONFIGURE,
  "authentication.succeeded": () => LOGON,
  "authentication.failed": () => LOGON,
  "authentication.token_in_url_rejected": () => LOGON,
  "upstream.token.issue": () => ({
    cls: "authentication",
    activity: "Token Issue",
  }),
  "upstream.token.issue_failed": () => ({
    cls: "authentication",
    activity: "Token Issue",
  }),
  "upstream.token.refresh": () => ({
    cls: "authentication",
    activity: "Token Refresh",
  }),
  "upstream.token.refresh_failed": () => ({
    cls: "authentication",
    activity: "Token Refresh",
  }),
  "upstream.token.invalidated": () => ({
    cls: "authentication",
    activity: "Token Invalidate",
  }),
  "authorization.policy_loaded": () => CONFIGURE,
  "authorization.allowed": _api,
  "authorization.denied": _api,
  "credential.provider.configured": () => CONFIGURE,
  "credential.config_invalid": () => START,
  "credential.lookup_failed": _api,
  "execution.policy.applied": () => CONFIGURE,
  "execution.requested": () => EXECUTE,
  "execution.import_denied": () => EXECUTE,
  "execution.resource_limit": (f) =>
    f.operation !== undefined
      ? _api(f)
      : f.pid !== undefined
        ? { cls: "process_activity", activity: "Limit" }
        : EXECUTE,
  "execution.capability_denied": () => ({
    cls: "process_activity",
    activity: "Capability Request",
  }),
  "execution.timeout": () => TERMINATE,
  "executor.terminated": () => TERMINATE,
  "execution.boundary_violation": () => ({
    cls: "detection_finding",
    activity: 1,
    statusId: 1, // New
    severityId: 3,
  }),
  "network.destination_denied": _http,
  "network.redirect_denied": _http,
  "transport.host_rejected": _http,
  "transport.origin_rejected": _http,
  "security.config_invalid": () => START,
  "security.unauthenticated_nonloopback_refused": () => START,
} satisfies Record<string, (f: Fields) => EventSpec>;

/** A security audit event name. */
export type AuditEvent = keyof typeof EVENTS;

/** Every security audit event name, in catalogue order. */
export const AUDIT_EVENTS = Object.keys(EVENTS) as AuditEvent[];

/** Outcome of a security audit event, as logged by call sites. */
export type AuditOutcome =
  "success" | "failure" | "allowed" | "denied" | "accepted" | "terminated";

/** Severity of a security audit event, as logged by call sites. */
export type AuditLevel = "info" | "warn" | "error";

/** `severity_id` for each logged level. */
const SEVERITY_ID: Readonly<Record<AuditLevel, number>> = {
  info: 1,
  warn: 2,
  error: 4,
};

const SEVERITY_NAMES: Readonly<Record<number, string>> = {
  1: "Informational",
  2: "Low",
  3: "Medium",
  4: "High",
};

const STATUS_NAMES: Readonly<Record<number, string>> = {
  1: "Success",
  2: "Failure",
};

/** `auth_protocol_id` and `auth_protocol` for an MCP authentication mode. */
const AUTH_PROTOCOL: Readonly<Record<string, [number, string]>> = {
  oauth: [6, "OAUTH 2.0"],
  "static-bearer": [99, "Bearer Token"],
  "stdio-process-boundary": [99, "Process Boundary"],
  none: [99, "None"],
};

/** Identity of the oag-mcp process recording the events. */
export interface OcsfProduct {
  /** Package name. */
  name: string;
  /** Package version. */
  version: string;
  /** Vendor (package author). */
  vendorName?: string;
  /** Server instance identifier. */
  instanceId: string;
}

/**
 * Reads event fields, remembering which were placed in an OCSF attribute so
 * that the rest can be kept under `unmapped`.
 *
 * @private
 */
class FieldReader {
  private readonly used = new Set<string>();

  constructor(private readonly fields: Fields) {}

  /** A field's value, marking it as placed. */
  take(key: string): unknown {
    this.used.add(key);
    return this.fields[key];
  }

  /** A string field, marking it as placed. */
  str(key: string): string | undefined {
    const v = this.take(key);
    return typeof v === "string" ? v : undefined;
  }

  /** A number field, marking it as placed. */
  num(key: string): number | undefined {
    const v = this.take(key);
    return typeof v === "number" ? v : undefined;
  }

  /** Whether a field is present, without placing it. */
  has(key: string): boolean {
    return this.fields[key] !== undefined;
  }

  /** The fields not placed in any OCSF attribute. */
  rest(): Fields {
    const out: Fields = {};
    for (const [k, v] of Object.entries(this.fields)) {
      if (v !== undefined && !this.used.has(k)) {
        out[k] = v;
      }
    }
    return out;
  }
}

/**
 * An endpoint for a URL origin, by IP address or hostname.
 *
 * @private
 */
function _origin(origin: string): Fields {
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    return net.isIP(host) ? { ip: host, port } : { hostname: host, port };
  } catch {
    return { name: origin };
  }
}

/**
 * The MCP client's endpoint: its address for Streamable HTTP, otherwise the
 * transport name.
 *
 * @private
 */
function _client(r: FieldReader): Fields {
  const ip = r.str("clientAddress");
  const port = r.num("clientPort");
  const transport = r.str("transport");
  if (ip) {
    return { ip, ...(port !== undefined ? { port } : {}) };
  }
  return { name: transport ?? "unknown" };
}

/**
 * The URL of an upstream request: origin and path template, never a query.
 *
 * @private
 */
function _url(origin: string | undefined, path: string | undefined): Fields {
  const url: Fields = { path };
  if (origin) {
    try {
      const u = new URL(origin);
      url.scheme = u.protocol.replace(/:$/, "");
      url.hostname = u.hostname;
      url.port = u.port ? Number(u.port) : undefined;
    } catch {
      // Not a URL; it is still reported as the destination endpoint.
    }
  }
  return _compact(url);
}

/**
 * The upstream request: method and URL.
 *
 * @private
 */
function _httpRequest(r: FieldReader, origin?: string): Fields | undefined {
  const method = r.str("httpMethod");
  const url = _url(origin, r.str("pathTemplate"));
  const hasUrl = Object.keys(url).length > 0;
  if (!method && !hasUrl) {
    return undefined;
  }
  return _compact({ http_method: method, url: hasUrl ? url : undefined });
}

/**
 * The actor: the authenticated caller, or oag-mcp itself.
 *
 * @private
 */
function _actor(r: FieldReader, product: OcsfProduct): Fields {
  const principal = r.str("principalId");
  return principal
    ? { user: { uid: principal } }
    : {
        app_name: product.name,
        process: { pid: process.pid, name: product.name },
      };
}

/**
 * A copy of an object without its undefined values.
 *
 * @private
 */
function _compact(obj: Fields): Fields {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

/**
 * Authentication: an MCP caller, or oag-mcp's own service identity obtaining
 * an upstream OAuth token.
 *
 * @private
 */
function _authentication(r: FieldReader, product: OcsfProduct): Fields {
  if (r.has("scheme")) {
    const status = r.num("status");
    return _compact({
      user: {
        uid: r.str("provider") ?? "upstream",
        type_id: 4,
        type: "Service",
      },
      service: { name: r.str("scheme") },
      auth_protocol_id: 6,
      auth_protocol: "OAUTH 2.0",
      status_code: status === undefined ? undefined : String(status),
    });
  }
  const principal = r.str("principalId");
  const [protocolId, protocol] = AUTH_PROTOCOL[r.str("mode") ?? ""] ?? [
    0,
    "Unknown",
  ];
  return {
    user: principal
      ? { uid: principal }
      : { name: "unknown", type_id: 0, type: "Unknown" },
    service: { name: product.name, version: product.version },
    auth_protocol_id: protocolId,
    auth_protocol: protocol,
    src_endpoint: _client(r),
  };
}

/**
 * API Activity: the `execute` tool call, or one SDK operation.
 *
 * @private
 */
function _apiActivity(r: FieldReader, product: OcsfProduct): Fields {
  const operationId = r.str("operationId");
  const executionId = r.str("executionId");
  return _compact({
    actor: _actor(r, product),
    api: _compact({
      operation: r.str("operation") ?? "execute",
      request: executionId ? { uid: executionId } : undefined,
      service: { name: product.name, version: product.version },
    }),
    src_endpoint: _client(r),
    resources: operationId
      ? [{ uid: operationId, type: "OpenAPI operation" }]
      : undefined,
    http_request: _httpRequest(r),
  });
}

/**
 * HTTP Activity: an outbound call names the upstream, an inbound request
 * the client.
 *
 * @private
 */
function _httpActivity(r: FieldReader, product: OcsfProduct): Fields {
  const origin = r.str("destinationOrigin");
  const endpoints = origin
    ? { dst_endpoint: _origin(origin) }
    : { src_endpoint: _client(r), dst_endpoint: { svc_name: product.name } };
  return _compact({
    actor: _actor(r, product),
    ...endpoints,
    http_request: _httpRequest(r, origin),
  });
}

/**
 * Process Activity: the Deno sandbox process.
 *
 * @private
 */
function _processActivity(r: FieldReader, product: OcsfProduct): Fields {
  return {
    actor: _actor(r, product),
    device: { type_id: 1, type: "Server", hostname: os.hostname() },
    process: _compact({
      name: "deno",
      pid: r.num("pid"),
      uid: r.str("executionId"),
    }),
  };
}

/**
 * Application Lifecycle: oag-mcp itself.
 *
 * @private
 */
function _applicationLifecycle(_r: FieldReader, product: OcsfProduct): Fields {
  return {
    app: _compact({
      name: product.name,
      version: product.version,
      vendor_name: product.vendorName,
    }),
  };
}

/**
 * Detection Finding: a forged bridge message from agent code.
 *
 * @private
 */
function _detectionFinding(r: FieldReader, product: OcsfProduct): Fields {
  return {
    actor: _actor(r, product),
    finding_info: {
      uid: crypto.randomUUID(),
      title: "Agent code sent a forged bridge message",
      types: ["Sandbox Boundary Violation"],
    },
  };
}

/** Class-specific attributes of each class. */
const CLASS_ATTRIBUTES: Readonly<
  Record<OcsfClass, (r: FieldReader, product: OcsfProduct) => Fields>
> = {
  authentication: _authentication,
  api_activity: _apiActivity,
  http_activity: _httpActivity,
  process_activity: _processActivity,
  application_lifecycle: _applicationLifecycle,
  detection_finding: _detectionFinding,
};

/**
 * The security control attributes of an allow or deny decision.
 *
 * @private
 */
function _control(outcome: AuditOutcome, r: FieldReader): Fields {
  if (outcome !== "allowed" && outcome !== "denied") {
    return {};
  }
  const stripped = r.take("strippedCredentials");
  const policy = r.str("policyId");
  const decision =
    outcome === "denied"
      ? {
          action_id: 2,
          action: "Denied",
          disposition_id: 2,
          disposition: "Blocked",
        }
      : Array.isArray(stripped) && stripped.length > 0
        ? {
            // Credentials supplied by agent code were removed.
            action_id: 4,
            action: "Modified",
            disposition_id: 11,
            disposition: "Corrected",
          }
        : {
            action_id: 1,
            action: "Allowed",
            disposition_id: 1,
            disposition: "Allowed",
          };
  return {
    ...decision,
    ...(policy ? { policy: { uid: policy } } : {}),
    ...(Array.isArray(stripped) ? { strippedCredentials: stripped } : {}),
  };
}

/**
 * The MCP tool call an event belongs to, as an AI Operation profile message
 * context: oag-mcp acts as a tool (`ai_role_id` 3) in the client's session.
 *
 * @private
 */
function _messageContext(
  cls: OcsfClass,
  r: FieldReader,
  product: OcsfProduct,
): Fields | undefined {
  if (cls === "detection_finding" || !r.has("toolName")) {
    return undefined;
  }
  const session = r.str("mcpSessionId");
  const tool = r.str("toolName");
  return {
    ...(session ? { uid: session } : {}),
    name: `tools/call ${tool}`,
    ai_role_id: 3,
    ai_role: "Tool",
    service: { name: product.name, version: product.version },
  };
}

/** Classes whose `actor` comes from the host profile rather than the class. */
const HOST_PROFILE: ReadonlySet<OcsfClass> = new Set([
  "http_activity",
  "detection_finding",
]);

/**
 * The classification attributes: category, class, activity and type.
 *
 * @private
 */
function _classification(spec: EventSpec): Fields {
  const cls = CLASSES[spec.cls];
  const activities: Record<number, string> = cls.activities;
  const numbered = typeof spec.activity === "number";
  const activityId = numbered ? (spec.activity as number) : OTHER;
  const activityName = numbered
    ? activities[activityId]
    : (spec.activity as string);
  return {
    category_uid: cls.category_uid,
    category_name: cls.category_name,
    class_uid: cls.uid,
    class_name: cls.name,
    activity_id: activityId,
    activity_name: activityName,
    type_uid: cls.uid * 100 + activityId,
    type_name: `${cls.name}: ${activityName}`,
  };
}

/**
 * The severity and status attributes.
 *
 * @private
 */
function _outcome(
  spec: EventSpec,
  outcome: AuditOutcome,
  level: AuditLevel,
  r: FieldReader,
): Fields {
  const severityId = spec.severityId ?? SEVERITY_ID[level];
  const failed = outcome === "failure" || outcome === "denied";
  const statusId = spec.statusId ?? (failed ? 2 : 1);
  const duration = r.num("durationMs");
  return _compact({
    severity_id: severityId,
    severity: SEVERITY_NAMES[severityId],
    status_id: statusId,
    // A finding's status is its lifecycle state: a new finding.
    status: spec.cls === "detection_finding" ? "New" : STATUS_NAMES[statusId],
    status_detail: r.str("reason"),
    status_code: r.str("errorCode"),
    duration,
  });
}

/**
 * The event metadata.
 *
 * @private
 */
function _metadata(
  event: AuditEvent,
  profiles: string[],
  r: FieldReader,
  product: OcsfProduct,
): Fields {
  return _compact({
    version: OCSF_VERSION,
    uid: crypto.randomUUID(),
    event_code: event,
    profiles,
    product: _compact({
      name: product.name,
      version: product.version,
      vendor_name: product.vendorName,
    }),
    reporter: {
      name: product.name,
      uid: product.instanceId,
      hostname: os.hostname(),
    },
    correlation_uid: r.str("requestId"),
  });
}

/**
 * The profiles an event uses beyond the class's own attributes.
 *
 * @private
 */
function _profiles(
  cls: OcsfClass,
  control: Fields,
  messageContext: Fields | undefined,
): string[] {
  return [
    "datetime",
    ...(HOST_PROFILE.has(cls) ? ["host"] : []),
    ...(control.action_id !== undefined ? ["security_control"] : []),
    ...(messageContext ? ["ai_operation"] : []),
  ];
}

/**
 * Convert a security audit event to an OCSF event.
 *
 * @param {String} event - oag-mcp event name
 * @param {String} outcome - logged outcome
 * @param {String} level - logged level
 * @param {Object} fields - context and event fields, already redacted and
 *   bounded
 * @param {Object} product - the recording oag-mcp instance
 * @param {Number} [time] - event time in milliseconds (default: now)
 * @return {Object} OCSF event (without `message`, which the logger adds)
 */
export function toOcsfEvent(
  event: AuditEvent,
  outcome: AuditOutcome,
  level: AuditLevel,
  fields: Fields,
  product: OcsfProduct,
  time: number = Date.now(),
): Fields {
  const spec = (EVENTS[event] as (f: Fields) => EventSpec)(fields);
  const r = new FieldReader(fields);
  const classification = _classification(spec);
  const outcomes = _outcome(spec, outcome, level, r);
  const attributes = CLASS_ATTRIBUTES[spec.cls](r, product);
  const messageContext = _messageContext(spec.cls, r, product);
  const { strippedCredentials, ...control } = _control(outcome, r);
  const metadata = _metadata(
    event,
    _profiles(spec.cls, control, messageContext),
    r,
    product,
  );
  const unmapped = _compact({ ...r.rest(), strippedCredentials });
  return _compact({
    time,
    time_dt: new Date(time).toISOString(),
    timezone_offset: 0,
    ...classification,
    ...outcomes,
    metadata,
    ...attributes,
    message_context: messageContext,
    ...control,
    unmapped: Object.keys(unmapped).length > 0 ? unmapped : undefined,
  });
}
