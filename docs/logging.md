# Logging

oag-mcp writes structured JSON logs, one record per line, in two
categories. Each category follows an open standard, so the records can be
ingested by standard tooling without custom parsing:

| Category | Standard | Contents | Level control |
| --- | --- | --- | --- |
| operational | [OpenTelemetry](https://opentelemetry.io/) log records: the [Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/), with attributes named by the [semantic conventions](https://opentelemetry.io/docs/specs/semconv/) 1.44.0 and the [MCP semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/) | CLI commands, start-up preparation stages and durations, compatibility failures, readiness, workspace cleanup, transports, search/execution lifecycle and durations, upstream call outcomes and latency | `--log-level` / `logging.level` |
| security audit | [OCSF](https://ocsf.io/) (Open Cybersecurity Schema Framework) 1.9.0 events | authentication, upstream token issue and refresh, authorization decisions (one per attempted SDK operation), credential lookup failures, security configuration, denied capabilities/imports/destinations/redirects, resource limits, timeouts, forced termination, forged bridge messages, refused start-up | **always written**; never sampled; unaffected by `--log-level` |

Every record has a stable event name: `EventName` in operational records and
`metadata.event_code` in audit records (the [event catalogue](#event-catalogue)
lists them). When both categories share one stream, tell them apart by
format, not by severity or message text: audit records have `class_uid`,
operational records have `SeverityNumber`.

```bash
jq 'select(.class_uid)' oag-mcp.log                    # security audit (OCSF)
jq 'select(.SeverityNumber)' oag-mcp.log               # operational (OpenTelemetry)
jq 'select(.metadata.event_code == "authorization.denied")' oag-mcp.log
jq 'select(.EventName == "upstream.call.completed") | .Attributes' oag-mcp.log
```

## Operational records (OpenTelemetry)

Each operational record is an OpenTelemetry log record, written with the
Logs Data Model's field names (shown here on several lines; it is one line in
the log):

```json
{
  "SeverityText": "INFO",
  "SeverityNumber": 9,
  "Timestamp": "1792913941936000000",
  "Resource": {
    "service.name": "oag-mcp",
    "service.version": "0.9.0",
    "service.instance.id": "inst_d58d4923-…"
  },
  "InstrumentationScope": { "Name": "oag-mcp.operational", "Version": "0.9.0" },
  "EventName": "upstream.call.completed",
  "Attributes": {
    "oag_mcp.request.id": "req_…",
    "network.transport": "tcp",
    "network.protocol.name": "http",
    "enduser.id": "static:reader",
    "client.address": "127.0.0.1",
    "client.port": 50000,
    "mcp.session.id": "…",
    "jsonrpc.request.id": 3,
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "execute",
    "oag_mcp.execution.id": "exec_…",
    "oag_mcp.operation": "PetsApi.listPets",
    "http.request.method": "GET",
    "url.template": "/pets",
    "http.response.status_code": 200,
    "oag_mcp.duration_ms": 18,
    "http.response.body.size": 112,
    "oag_mcp.outcome": "success"
  },
  "Body": "upstream.call.completed"
}
```

| Field | Content |
| --- | --- |
| `Timestamp` | nanoseconds since the Unix epoch, as a string |
| `SeverityText`, `SeverityNumber` | `TRACE` 1, `DEBUG` 5, `INFO` 9, `WARN` 13, `ERROR` 17, `FATAL` 21 |
| `Resource` | `service.name`, `service.version`, `service.instance.id` (one per server process) |
| `InstrumentationScope` | `oag-mcp.operational` and the oag-mcp version |
| `EventName`, `Body` | the event name |
| `Attributes` | the event's details, named as below |

Attributes use the semantic convention name where one exists:

| Attribute | Content |
| --- | --- |
| `enduser.id` | the authenticated MCP caller (principal id) |
| `client.address`, `client.port` | the Streamable HTTP client |
| `network.transport`, `network.protocol.name` | `pipe` for stdio; `tcp` and `http` for Streamable HTTP |
| `mcp.method.name`, `mcp.session.id`, `jsonrpc.request.id` | the MCP request of a tool call |
| `gen_ai.tool.name`, `gen_ai.operation.name` | the tool (`search` or `execute`), and `execute_tool` |
| `http.request.method`, `url.template`, `http.response.status_code`, `http.response.body.size` | an upstream API call (the URL as a path template, never with a query) |
| `server.address`, `server.port` | the address the HTTP transport listens on |
| `error.type` | the error name or code of a failure |

Everything else is in the `oag_mcp.` namespace in snake_case, for example
`oag_mcp.request.id`, `oag_mcp.execution.id`, `oag_mcp.duration_ms` and
`oag_mcp.outcome`. The MCP, `gen_ai.*`, `enduser.id`, `url.template` and
`http.response.body.size` conventions are still marked *Development* by
OpenTelemetry, so their names may change in later convention versions.

### Sending operational records to an OpenTelemetry Collector

The [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
(contrib distribution) can read the operational log file and turn each
record back into an OpenTelemetry log record, with its resource, scope,
timestamp, severity, event name and attributes:

```yaml
receivers:
  file_log:
    include: [/var/log/oag-mcp/operational.log]
    operators:
      - type: json_parser
        timestamp:
          parse_from: attributes.Timestamp
          layout_type: epoch
          layout: ns
        severity:
          parse_from: attributes.SeverityNumber
          mapping: { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 }
        scope_name:
          parse_from: attributes.InstrumentationScope.Name
      - { type: move, from: attributes.Body, to: body }
      - { type: move, from: attributes.Attributes, to: attributes.otel_attrs }
      - { type: remove, field: attributes.Timestamp }
      - { type: remove, field: attributes.SeverityNumber }
      - { type: remove, field: attributes.InstrumentationScope }
processors:
  transform:
    log_statements:
      - context: log
        statements:
          - merge_maps(resource.attributes, log.attributes["Resource"], "upsert")
          - set(log.severity_text, log.attributes["SeverityText"])
          - set(log.event_name, log.attributes["EventName"])
          - merge_maps(log.attributes, log.attributes["otel_attrs"], "upsert")
          - delete_key(log.attributes, "otel_attrs")
          - delete_key(log.attributes, "Resource")
          - delete_key(log.attributes, "SeverityText")
          - delete_key(log.attributes, "EventName")
exporters:
  otlp:
    endpoint: otel-backend.example.com:4317
service:
  pipelines:
    logs:
      receivers: [file_log]
      processors: [transform]
      exporters: [otlp]
```

## Security audit records (OCSF)

Each security audit record is an OCSF 1.9.0 event (shown here on several
lines; it is one line in the log):

```json
{
  "time": 1792913942095,
  "time_dt": "2026-10-25T07:39:02.095Z",
  "timezone_offset": 0,
  "category_uid": 6,
  "category_name": "Application Activity",
  "class_uid": 6003,
  "class_name": "API Activity",
  "activity_id": 4,
  "activity_name": "Delete",
  "type_uid": 600304,
  "type_name": "API Activity: Delete",
  "severity_id": 2,
  "severity": "Low",
  "status_id": 2,
  "status": "Failure",
  "status_detail": "rule_deny",
  "metadata": {
    "version": "1.9.0",
    "uid": "d9df38d3-…",
    "event_code": "authorization.denied",
    "profiles": ["datetime", "security_control", "ai_operation"],
    "product": { "name": "oag-mcp", "version": "0.9.0", "vendor_name": "OpenAPI Clients Factory" },
    "reporter": { "name": "oag-mcp", "uid": "inst_d58d4923-…", "hostname": "mcp-1" },
    "correlation_uid": "req_…"
  },
  "actor": { "user": { "uid": "static:reader" } },
  "api": {
    "operation": "AdminApi.deletePet",
    "request": { "uid": "exec_…" },
    "service": { "name": "oag-mcp", "version": "0.9.0" }
  },
  "src_endpoint": { "ip": "127.0.0.1", "port": 50000 },
  "resources": [{ "uid": "deletePet", "type": "OpenAPI operation" }],
  "http_request": { "http_method": "DELETE", "url": { "path": "/pets/{petId}" } },
  "message_context": {
    "uid": "…",
    "name": "tools/call execute",
    "ai_role_id": 3,
    "ai_role": "Tool",
    "service": { "name": "oag-mcp", "version": "0.9.0" }
  },
  "action_id": 2,
  "action": "Denied",
  "disposition_id": 2,
  "disposition": "Blocked",
  "policy": { "uid": "no-admin" },
  "unmapped": { "jsonrpcRequestId": 3 },
  "message": "authorization.denied"
}
```

oag-mcp uses six OCSF classes:

| Class | Used for |
| --- | --- |
| Authentication (3002) | MCP caller authentication (activity Logon); upstream OAuth tokens (activities Token Issue, Token Refresh, Token Invalidate) |
| API Activity (6003) | the `execute` tool call (activity Execute) and the authorization decision for each SDK operation (activity Create, Read, Update or Delete, from its HTTP method) |
| HTTP Activity (4002) | denied upstream destinations and redirects, and HTTP requests rejected for their Host or Origin (activity from the HTTP method) |
| Process Activity (1007) | the Deno sandbox process: denied capabilities, limits, timeouts and termination |
| Application Lifecycle (6002) | security configuration applied at start-up (activity Configure), and start-up refused for security reasons (activity Start, status Failure) |
| Detection Finding (2004) | forged bridge messages sent by agent code |

Common attributes:

| Attribute | Content |
| --- | --- |
| `time`, `time_dt` | milliseconds since the Unix epoch, and the same time in ISO 8601 |
| `severity_id` | 1 Informational, 2 Low (denials and other warnings), 3 Medium (detection findings), 4 High (refused start-up) |
| `status_id`, `status_detail` | 1 Success or 2 Failure, and oag-mcp's reason code |
| `action_id`, `disposition_id`, `policy` | for allow and deny decisions (Security Control profile): Allowed, Denied, or Modified when credentials supplied by agent code were removed from an allowed request |
| `metadata.event_code` | oag-mcp's event name |
| `metadata.correlation_uid` | the MCP request id (the same request's `oag_mcp.request.id` in operational records) |
| `metadata.reporter.uid` | the server instance id (`service.instance.id` in operational records) |
| `actor.user.uid` (`user.uid` for Authentication) | the authenticated MCP caller (`user.name: unknown` when authentication failed) |
| `src_endpoint` | the Streamable HTTP client's address, or `{"name": "stdio"}` |
| `api.operation`, `api.request.uid` | the SDK method and the execution id |
| `process.uid` | the execution id of a sandbox process |
| `message_context` | the MCP tool call (AI Operation profile): session id, `tools/call <tool>`, oag-mcp in the Tool role |
| `unmapped` | details OCSF does not define, under their oag-mcp field names (for example `limit`, `capability`, `strippedCredentials`) |

`make -f Makefile-extras test-ocsf` validates oag-mcp's audit records
against the OCSF schema (see [Testing](testing.md#ocsf-conformance)).

Every attempted SDK operation produces exactly one decision record:
`authorization.allowed` (with the credential schemes applied),
`authorization.denied`, `network.destination_denied` or
`credential.lookup_failed`.

Correlation ids flow from the MCP request through the execution to each SDK
call, in both categories.

## Destinations

```bash
# both categories to stderr as one JSON stream (default)
oag-mcp serve --spec openapi.yaml --sdk ./sdk --transport stdio 2>oag-mcp.log
jq 'select(.class_uid)' oag-mcp.log

# separate files
oag-mcp serve --spec openapi.yaml --sdk ./sdk --transport streamable-http \
  --log-file /var/log/oag-mcp/operational.log \
  --audit-log-file /var/log/oag-mcp/audit.log

# quiet operational logs, auditing continues
oag-mcp serve --spec openapi.yaml --sdk ./sdk --log-level silent --audit-log-file audit.log

# forward audit records to a collector through a file descriptor
oag-mcp serve --spec openapi.yaml --sdk ./sdk --audit-log-file fd:3 3> >(vector --config vector.toml)

# human-readable for local development (stderr only)
oag-mcp serve --spec openapi.yaml --sdk ./sdk --transport stdio --log-format pretty
```

OCSF is the schema used by security data lakes and SIEMs such as Amazon
Security Lake, so a separate audit file maps directly onto them.

For stdio MCP, stdout carries **only** protocol messages, including while
the SDK is being prepared at start-up: logs (including pretty output) and
start-up errors go to stderr or files, the TypeScript compiler and esbuild
run silently, and the Deno verification run's output is captured.
`stdout`/`fd:1` are refused as log destinations.

Files are opened in append mode with `0600` permissions. Writes are
synchronous so failures are detected immediately and logs are flushed on
graceful shutdown (`SIGINT`/`SIGTERM`).

When stderr is a pipe whose reader falls behind (for example an MCP client
that reads the server's stderr slowly), oag-mcp waits for it rather than
dropping records: a full pipe is retried for about two seconds. If the reader
still has not caught up, the write counts as a failure (see below), further
writes fail fast instead of waiting again, and records not yet written (up to
1 MiB) are kept and written in order once the reader catches up.

## Audit destination failures

If an audit record cannot be written, oag-mcp reports
`logging.destination_failed` (an operational record) directly to stderr,
without recursing into the logger. With `--audit-fail-closed`
(`logging.auditFailClosed: true`), `execute` calls are then refused with
`audit_unavailable` until restart. `search` continues to work.

Local files are not tamper-proof storage. For audit integrity, forward records
to a user-managed collector or append-only store (journald, Vector,
Fluent Bit, a SIEM).

## Redaction

- A structural sanitizer, applied to every record before it is formatted,
  censors keys such as `authorization`, `cookie`, `password`, `token`,
  `apiKey`, `client_secret` at any depth and in any letter case.
- Every resolved secret and issued token is registered and scrubbed from all
  strings (including base64 forms used by Basic auth); bearer/basic header
  values, JWT-shaped strings and credential-bearing query parameters are
  masked.
- URLs are logged as origin + path template, never with query strings.
- Agent code, search queries, request/response bodies and execution results
  are not logged; only identifiers, operation names, policy ids, reason codes,
  sizes and durations.
- Strings are length-bounded and objects depth-bounded.

## Event catalogue

Operational: `cli.command.started|completed|failed`, `prepare.started`,
`prepare.stage.started|completed|failed` (`oag_mcp.stage`: `inputs`,
`compatibility`, `sdk`, `index`, `executor`; with `oag_mcp.duration_ms`),
`prepare.spec.loaded`, `prepare.sdk.resolved`, `prepare.compat.checked`,
`prepare.compat.failed`, `prepare.sdk.bundled`, `prepare.index.created`,
`prepare.warning`, `prepare.sdk.prepared` (total preparation duration,
input hashes), `prepare.aborted`, `prepare.failed`,
`prepare.workspace.stale_removed`, `prepare.workspace.removed`,
`prepare.workspace.cleaned`, `prepare.workspace.cleanup_failed`,
`executor.runtime.resolved`, `executor.verified`, `tools.registered`,
`transport.initialized`, `transport.remote_exposure`,
`transport.connection_failed`, `transport.request_failed`, `transport.error`,
`server.ready` (with `oag_mcp.startup_duration_ms`),
`server.shutdown_requested` (`oag_mcp.signal` includes `stdin_closed`;
`oag_mcp.phase`: `starting` or `serving`), `server.stopped`,
`typecheck.warmed`, `typecheck.warm_failed`, `search.completed`,
`execution.started|completed|failed`,
`upstream.call.completed|failed|redirected`, `upstream.token.cache_hit`,
`logging.destination_failed`, `logging.destination_open_failed`.

Security audit:

| Event | OCSF class: activity |
| --- | --- |
| `authentication.mode_configured` | Application Lifecycle: Configure |
| `authentication.succeeded`, `authentication.failed`, `authentication.token_in_url_rejected` | Authentication: Logon |
| `upstream.token.issue`, `upstream.token.issue_failed` | Authentication: Token Issue |
| `upstream.token.refresh`, `upstream.token.refresh_failed` | Authentication: Token Refresh |
| `upstream.token.invalidated` | Authentication: Token Invalidate |
| `authorization.policy_loaded` | Application Lifecycle: Configure |
| `authorization.allowed`, `authorization.denied`, `credential.lookup_failed` | API Activity: Create, Read, Update or Delete |
| `credential.provider.configured` | Application Lifecycle: Configure |
| `credential.config_invalid` | Application Lifecycle: Start (Failure) |
| `execution.policy.applied` | Application Lifecycle: Configure |
| `execution.requested`, `execution.import_denied` | API Activity: Execute |
| `execution.resource_limit` | API Activity (code size, concurrency, result limits; request and response size of an SDK call) or Process Activity: Limit (sandbox limits) |
| `execution.capability_denied` | Process Activity: Capability Request |
| `execution.timeout`, `executor.terminated` | Process Activity: Terminate |
| `execution.boundary_violation` | Detection Finding: Create |
| `network.destination_denied`, `network.redirect_denied` | HTTP Activity: the request's method |
| `transport.host_rejected`, `transport.origin_rejected` | HTTP Activity: the request's method |
| `security.config_invalid`, `security.unauthenticated_nonloopback_refused` | Application Lifecycle: Start (Failure) |
