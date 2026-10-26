# Log events reference

oag-mcp writes two kinds of log record, each in an open standard so that
standard tooling can ingest it without custom parsing:

- **Operational logs**, as [OpenTelemetry](https://opentelemetry.io/) log
  records: start-up, transports, tool calls, upstream API calls, timings and
  failures. Filtered by the operational log level.
- **Security audit logs**, as [OCSF](https://ocsf.io/) (Open Cybersecurity
  Schema Framework) events: authentication, authorization decisions,
  credential use, security configuration and enforced limits. Always written,
  whatever the log level, and never sampled.

Every record is one JSON object on one line, and has a stable event name:
`EventName` in operational records, `metadata.event_code` in audit records.
The tables below list every event.

**With no log flags or `logging` configuration, both kinds go to stderr**, as
JSON, interleaved in one stream, with operational records at level `info`
and above. stdout is never used: with the stdio transport it carries only MCP
protocol messages, so `stdout` and `fd:1` are refused as log destinations.
To change that:

| Setting | Flag | Configuration | Default |
| --- | --- | --- | --- |
| Operational destination: a file path or `fd:N` | `--log-file` | `logging.file` | stderr |
| Audit destination: a file path or `fd:N` | `--audit-log-file` | `logging.auditFile` | stderr |
| Operational level (`silent` turns operational records off; audit records continue) | `--log-level` | `logging.level` | `info` |
| `json`, or `pretty` for local development (stderr only; files are always JSON) | `--log-format` | `logging.format` | `json` |
| Refuse `execute` calls while audit records cannot be written | `--audit-fail-closed` | `logging.auditFailClosed` | off |

Files are opened for appending with `0600` permissions, and written
synchronously, so a failing destination is noticed at once. When both kinds
share a stream, tell them apart by shape, not by level or text: audit records
have `class_uid`, operational records have `SeverityNumber`.

```bash
oag-mcp serve --spec openapi.yaml --sdk ./sdk 2>oag-mcp.log
jq 'select(.SeverityNumber)' oag-mcp.log     # operational
jq 'select(.class_uid)' oag-mcp.log          # security audit
```

The `pretty` format prints one line per record, with an operational record's
attributes below it:

```text
[00:11:16.578] INFORMATIONAL: [security_audit] authorization.allowed API Activity: Read Allowed (default_allow)
[00:11:16.596] INFO: [operational] upstream.call.completed success
    Attributes: {
      "oag_mcp.operation": "PetsApi.listPets",
      …
    }
[00:11:16.664] LOW: [security_audit] authorization.denied API Activity: Delete Denied (rule_deny)
```

Neither kind ever contains credentials, agent code, search queries, request
or response bodies, or execution results: only identifiers, operation names,
policy ids, reason codes, sizes and durations. URLs appear as a path template,
without the query. [Logging](../logging.md) covers redaction, shipping logs to
an OpenTelemetry Collector or a SIEM, and audit destination failures.

## Operational logs

Operational records follow the OpenTelemetry
[Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/),
using its field names. Attributes are named by the OpenTelemetry
[semantic conventions](https://opentelemetry.io/docs/specs/semconv/) 1.44.0,
including the [MCP conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/mcp/),
where a convention exists. The rest are in the `oag_mcp.` namespace, in
snake_case. The MCP, `gen_ai.*`, `enduser.id`, `url.template` and
`http.response.body.size` conventions are still marked *Development* by
OpenTelemetry, so their names may change in later versions.

This record is from an `execute` call over stdio that called
`PetsApi.listPets`, shown on several lines; in the log it is one line:

```json
{
  "SeverityText": "INFO",
  "SeverityNumber": 9,
  "Timestamp": "1793020217513000000",
  "Resource": {
    "service.name": "oag-mcp",
    "service.version": "0.9.0-pre.0",
    "service.instance.id": "inst_d1d08f0e-1644-4c92-86da-866f12624cc0"
  },
  "InstrumentationScope": { "Name": "oag-mcp.operational", "Version": "0.9.0-pre.0" },
  "EventName": "upstream.call.completed",
  "Attributes": {
    "oag_mcp.request.id": "req_952f0680-42f6-4bb8-98d5-26f73a002fe2",
    "network.transport": "pipe",
    "enduser.id": "local:local",
    "jsonrpc.request.id": 3,
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "execute",
    "oag_mcp.execution.id": "exec_ff046664-b386-4209-9708-5f21b3e15db3",
    "oag_mcp.operation": "PetsApi.listPets",
    "http.request.method": "GET",
    "url.template": "/pets",
    "http.response.status_code": 200,
    "oag_mcp.duration_ms": 25,
    "http.response.body.size": 222,
    "oag_mcp.outcome": "success"
  },
  "Body": "upstream.call.completed"
}
```

### Operational fields

`Resource` and `Attributes` keys contain dots but are single keys, so in `jq`
they are written `.Resource["service.name"]` and
`.Attributes["oag_mcp.request.id"]`.

| Field | Description | Type | Present | Example |
| --- | --- | --- | --- | --- |
| `Timestamp` | When the event happened, in nanoseconds since the Unix epoch (millisecond precision). | string | Always | `"1793020217513000000"` |
| `SeverityText` | The level: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` or `FATAL`. | string | Always | `"INFO"` |
| `SeverityNumber` | The level as an OpenTelemetry severity number: 1, 5, 9, 13, 17 or 21. | integer | Always | `9` |
| `Resource["service.name"]` | The service: always `oag-mcp`. | string | Always | `"oag-mcp"` |
| `Resource["service.version"]` | The oag-mcp version. | string | Always | `"0.9.0-pre.0"` |
| `Resource["service.instance.id"]` | A random id for this server process, the same as `metadata.reporter.uid` in its audit records. | string | Always, except in `logging.destination_failed` | `"inst_d1d08f0e-…"` |
| `InstrumentationScope.Name` | Always `oag-mcp.operational`. | string | Always | `"oag-mcp.operational"` |
| `InstrumentationScope.Version` | The oag-mcp version. | string | Always | `"0.9.0-pre.0"` |
| `EventName` | The event name, from [Operational events](#operational-events). | string | Always | `"upstream.call.completed"` |
| `Body` | The event name again. | string | Always | `"upstream.call.completed"` |
| `Attributes` | The event's details: the context attributes below, then the event's own. | object | Always | `{"oag_mcp.outcome": "success"}` |

### Context attributes

Records written while handling a request carry attributes that identify it.
Those of a `search` or `execute` call carry all of these that apply; those of
a Streamable HTTP request outside a tool call carry the request id, transport
and client.

| Attribute | Description | Type | Present | Example |
| --- | --- | --- | --- | --- |
| `oag_mcp.request.id` | The MCP request, the same as `metadata.correlation_uid` in audit records. | string | Tool calls; Streamable HTTP requests | `"req_952f0680-…"` |
| `oag_mcp.execution.id` | The `execute` call, the same as the `executionId` the call returns. | string | `execute` calls | `"exec_ff046664-…"` |
| `network.transport` | `pipe` for stdio, `tcp` for Streamable HTTP. | string | Tool calls; transport events | `"pipe"`, `"tcp"` |
| `network.protocol.name` | `http`, with Streamable HTTP. | string | Streamable HTTP | `"http"` |
| `enduser.id` | The authenticated MCP caller: `local:<principal>` for stdio, `static:<principal>` for a static bearer token, `oauth:<hash>` for OAuth, `anonymous` with `mcpAuth.mode: none`. | string | Tool calls | `"local:local"`, `"static:ci-bot"` |
| `client.address`, `client.port` | The Streamable HTTP client. | string, integer | Streamable HTTP | `"127.0.0.1"`, `50000` |
| `mcp.session.id` | The MCP session. | string | Streamable HTTP tool calls | `"6f1c…"` |
| `jsonrpc.request.id` | The JSON-RPC id of the tool call. | string or integer | Tool calls | `3` |
| `mcp.method.name` | Always `tools/call`. | string | Tool calls | `"tools/call"` |
| `gen_ai.operation.name` | Always `execute_tool`. | string | Tool calls | `"execute_tool"` |
| `gen_ai.tool.name` | The tool called. | string | Tool calls | `"search"`, `"execute"` |
| `oag_mcp.outcome` | Whether the event's action worked. | string | Events that complete or fail an action | `"success"`, `"failure"` |
| `oag_mcp.duration_ms` | How long the action took, in milliseconds. | integer | Timed events | `25` |
| `error.type` | The error name or code of a failure. | string | Failures | `"permission_denied"`, `"SDK_LAYOUT_UNSUPPORTED"` |

### Operational events

All events, with their level and own attributes (`oag_mcp.` is left out of
attribute names here). Events at `debug` appear only with
`--log-level debug` or `trace`.

| Event | Level | Description | Attributes |
| --- | --- | --- | --- |
| `cli.command.started` | info | `oag-mcp serve` started. | `command`, `network.transport` |
| `cli.command.completed` | info | The command finished normally. | `command`, `outcome` |
| `cli.command.failed` | error | The command failed; the error and hint are also printed to stderr. | `command`, `error.type`, `outcome` |
| `prepare.started` | info | Start-up preparation of the spec and SDK began. | `prepare.id` |
| `prepare.stage.started` | debug | A preparation stage began: `inputs`, `compatibility`, `sdk`, `index` or `executor`. | `stage` |
| `prepare.stage.completed` | info | A preparation stage finished. | `stage`, `duration_ms`, `outcome` |
| `prepare.stage.failed` | error | A preparation stage failed. | `stage`, `error.type`, `duration_ms`, `outcome` |
| `prepare.spec.loaded` | info | The OpenAPI document was read. | `openapi_version`, `operations`, `security_schemes` |
| `prepare.sdk.resolved` | info | The SDK input was found. | `sdk_kind` (`directory` or `archive`) |
| `prepare.compat.checked` | info | The SDK passed the compatibility checks. | `layout`, `oag_version`, `oag_version_tested`, `api_files`, `outcome` |
| `prepare.compat.failed` | error | The SDK failed the compatibility checks. | `error.type`, `outcome` |
| `prepare.sdk.bundled` | info | The SDK was bundled for the sandbox. | `bytes`, `exports` |
| `prepare.index.created` | info | The method index was built. | `methods`, `api_classes`, `unmapped_operations` |
| `prepare.warning` | warn | Preparation found something worth knowing, such as an operation it could not map. | `warning` |
| `prepare.sdk.prepared` | info | Preparation finished, with hashes identifying the inputs. | `prepare.id`, `methods`, `oag_version`, `sdk_layout`, `sdk_kind`, `spec_sha256`, `sdk_sha256`, `duration_ms` |
| `prepare.aborted` | info | A signal stopped preparation. | `stage` |
| `prepare.failed` | error | Preparation failed. | `prepare.id`, `error.type`, `duration_ms`, `outcome` |
| `prepare.workspace.stale_removed` | info | Preparation folders left by earlier runs were removed. | `count` |
| `prepare.workspace.removed` | debug | The preparation folder was removed. | `outcome` |
| `prepare.workspace.cleaned` | info | The preparation folder was cleaned up at shutdown. | `outcome` |
| `prepare.workspace.cleanup_failed` | warn | The preparation folder could not be removed. | `error.type`, `outcome` |
| `executor.runtime.resolved` | info | The Deno binary was found. | `executor`, `deno_version`, `source` (`configured`, `env`, `npm-package` or `path`) |
| `executor.verified` | info | A trial run checked that the sandbox can load the SDK. | `executor`, `bindings`, `outcome` |
| `typecheck.warmed` | debug | The type checker was loaded ahead of the first call. | `duration_ms` |
| `typecheck.warm_failed` | warn | The type checker could not be loaded ahead of time. | `error.type` |
| `tools.registered` | info | The MCP tools were registered. | `tools`, `methods` |
| `transport.initialized` | info | The transport is ready; for Streamable HTTP, with its address. | `network.transport`, `server.address`, `server.port`, `path`, `mcp_auth_mode`, `outcome` |
| `transport.remote_exposure` | warn | Streamable HTTP is bound to a non-loopback address. | `server.address`, `note` |
| `transport.connection_failed` | warn | A Streamable HTTP connection failed. | `network.transport`, `error.type` |
| `transport.request_failed` | warn, error | An MCP request could not be handled. | `network.transport`, `error.type` |
| `transport.error` | error | The transport reported an error. | `network.transport`, `error.type` |
| `server.ready` | info | The server is ready for MCP clients. | `network.transport`, `prepare.id`, `methods`, `startup_duration_ms` |
| `server.shutdown_requested` | info | A shutdown began. | `signal` (`SIGINT`, `SIGTERM` or `stdin_closed`), `phase` (`starting` or `serving`) |
| `server.stopped` | info | The server stopped. | `network.transport` |
| `search.completed` | info | A `search` call finished. | `mode` (`query`, `detail` or `browse`), `results`, `duration_ms`, `outcome` |
| `execution.started` | info | An `execute` call passed its checks and started. | `language` |
| `execution.completed` | info | An `execute` call succeeded. | `duration_ms`, `sdk_calls`, `terminated`, `outcome` |
| `execution.failed` | info | An `execute` call failed; `error.type` is the [error type](error-types.md). | `error.type`, `reason` (when refused before running), `duration_ms`, `sdk_calls`, `terminated`, `outcome` |
| `upstream.call.completed` | info | An SDK call got a response from the API, whatever its status. | `operation`, `http.request.method`, `url.template`, `http.response.status_code`, `http.response.body.size`, `duration_ms`, `outcome` |
| `upstream.call.failed` | warn | An SDK call got no response. | `operation`, `http.request.method`, `url.template`, `duration_ms`, `reason` (`timeout`, `network_error` or `execution_ended`), `error.type` |
| `upstream.call.redirected` | debug | The API redirected an SDK call, and the redirect was followed. | `operation`, `http.response.status_code`, `same_origin` |
| `upstream.token.cache_hit` | debug | A cached OAuth2 token was reused for an upstream call. | `scheme` |
| `logging.destination_open_failed` | error | A log file could not be opened. Written straight to stderr. | `destination` (`operational` or `security_audit`), `error.type`, `fail_closed`, `outcome` |
| `logging.destination_failed` | error | A log destination failed to accept a record. Written straight to stderr, for the first three failures. | `destination`, `error.type`, `outcome` |

## Security audit logs

Audit records are [OCSF 1.9.0](https://schema.ocsf.io/1.9.0/) events, the
schema that security data lakes and SIEMs such as Amazon Security Lake take
in. Each event is in one of six OCSF classes, chosen by its event name:

| Class | Used for |
| --- | --- |
| Authentication (3002) | Authenticating MCP callers (activity Logon), and the upstream OAuth2 tokens oag-mcp obtains (Token Issue, Token Refresh, Token Invalidate). |
| API Activity (6003) | The `execute` call (activity Execute), and the authorization decision for each SDK call (Create, Read, Update or Delete, from its HTTP method). |
| HTTP Activity (4002) | Denied upstream destinations and redirects, and inbound requests rejected for their `Host` or `Origin` (activity from the HTTP method). |
| Process Activity (1007) | The Deno sandbox process: denied capabilities, limits, timeouts and termination. |
| Application Lifecycle (6002) | Security configuration applied at start-up (activity Configure), and start-up refused for security reasons (Start, with status Failure). |
| Detection Finding (2004) | Forged bridge messages sent by agent code. |

Records also use OCSF profiles: Date/Time (`time_dt`), Security Control for
allow and deny decisions, Host for an `actor` where the class has none, and
AI Operation for the MCP tool call (`message_context`). `metadata.profiles`
lists those a record uses. `make -f Makefile-extras test-ocsf` validates the
records against the OCSF schema (see [Testing](../testing.md#ocsf-conformance)).

This record is from the same stdio session, where a `read-only` rule denied
`AdminApi.deletePet`:

```json
{
  "time": 1793020217607,
  "time_dt": "2026-10-26T13:10:17.607Z",
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
    "uid": "37d92a99-b8b8-4c12-a110-69f00ade08f1",
    "event_code": "authorization.denied",
    "profiles": ["datetime", "security_control", "ai_operation"],
    "product": { "name": "oag-mcp", "version": "0.9.0-pre.0", "vendor_name": "OpenAPI Clients Factory" },
    "reporter": { "name": "oag-mcp", "uid": "inst_d1d08f0e-1644-4c92-86da-866f12624cc0", "hostname": "vm" },
    "correlation_uid": "req_3ac1979f-fe31-4626-80ab-6d35f0ee7a52"
  },
  "actor": { "user": { "uid": "local:local" } },
  "api": {
    "operation": "AdminApi.deletePet",
    "request": { "uid": "exec_bbfb35f5-83e9-454a-97cf-9a62cc2b9563" },
    "service": { "name": "oag-mcp", "version": "0.9.0-pre.0" }
  },
  "src_endpoint": { "name": "stdio" },
  "resources": [{ "uid": "deletePet", "type": "OpenAPI operation" }],
  "http_request": { "http_method": "DELETE", "url": { "path": "/pets/{petId}" } },
  "message_context": {
    "name": "tools/call execute",
    "ai_role_id": 3,
    "ai_role": "Tool",
    "service": { "name": "oag-mcp", "version": "0.9.0-pre.0" }
  },
  "action_id": 2,
  "action": "Denied",
  "disposition_id": 2,
  "disposition": "Blocked",
  "policy": { "uid": "read-only" },
  "unmapped": { "jsonrpcRequestId": 4 },
  "message": "authorization.denied"
}
```

### Audit fields

| Field | Description | Type | Present | Example |
| --- | --- | --- | --- | --- |
| `time` | When the event happened, in milliseconds since the Unix epoch. | integer | Always | `1793020217607` |
| `time_dt` | The same time in ISO 8601, UTC. | string | Always | `"2026-10-26T13:10:17.607Z"` |
| `timezone_offset` | Always `0`: times are UTC. | integer | Always | `0` |
| `category_uid`, `category_name` | The OCSF category of the class. | integer, string | Always | `6`, `"Application Activity"` |
| `class_uid`, `class_name` | The OCSF class (see the table above). | integer, string | Always | `6003`, `"API Activity"` |
| `activity_id`, `activity_name` | What happened. `activity_id` 99 (Other) means the activity is named only by `activity_name`, such as `Execute`, `Configure` or `Token Issue`. | integer, string | Always | `4`, `"Delete"` |
| `type_uid`, `type_name` | The class and activity combined: `class_uid` × 100 + `activity_id`. | integer, string | Always | `600304`, `"API Activity: Delete"` |
| `severity_id`, `severity` | 1 Informational, 2 Low (denials and other warnings), 3 Medium (detection findings), 4 High (start-up refused). | integer, string | Always | `2`, `"Low"` |
| `status_id`, `status` | 1 Success or 2 Failure; `New` for a detection finding. | integer, string | Always | `2`, `"Failure"` |
| `status_detail` | oag-mcp's reason code, listed per event below. | string | When there is a reason | `"rule_deny"` |
| `status_code` | An error code, or the HTTP status a token endpoint returned. | string | Some failures | `"401"` |
| `duration` | How long the action took, in milliseconds. | integer | Token events | `84` |
| `metadata.version` | The OCSF version. | string | Always | `"1.9.0"` |
| `metadata.uid` | A unique id for this record. | string | Always | `"37d92a99-…"` |
| `metadata.event_code` | The oag-mcp event name, from [Audit events](#audit-events). | string | Always | `"authorization.denied"` |
| `metadata.profiles` | The OCSF profiles the record uses. | string[] | Always | `["datetime", "security_control"]` |
| `metadata.product` | oag-mcp's name, version and vendor. | object | Always | `{"name": "oag-mcp", …}` |
| `metadata.reporter` | The recording process: name, instance id (`service.instance.id` in operational records) and host name. | object | Always | `{"uid": "inst_d1d08f0e-…", …}` |
| `metadata.correlation_uid` | The MCP request, the same as `oag_mcp.request.id` in operational records. | string | Records from a request | `"req_3ac1979f-…"` |
| `actor.user.uid` | The authenticated MCP caller, as in `enduser.id`. Without a caller, `actor` names oag-mcp itself (`app_name` and `process`). | string | Records with an actor | `"local:local"` |
| `user`, `service`, `auth_protocol_id`, `auth_protocol` | Authentication: who authenticated, to what, and how (`OAUTH 2.0`, `Bearer Token`, `Process Boundary` or `None`). For upstream tokens, `user` is oag-mcp's service identity and `service.name` the security scheme. | object, integer, string | Authentication | `{"uid": "static:ci-bot"}`, `"Bearer Token"` |
| `src_endpoint` | Where the request came from: the Streamable HTTP client's `ip` and `port`, or `{"name": "stdio"}`. | object | Records from a request | `{"ip": "127.0.0.1", "port": 50000}` |
| `dst_endpoint` | Where a denied upstream request or redirect was going. | object | HTTP Activity | `{"hostname": "evil.example.test", "port": 80}` |
| `api.operation`, `api.request.uid` | The SDK method (or `execute`), and the execution id. | string | API Activity | `"AdminApi.deletePet"`, `"exec_bbfb35f5-…"` |
| `resources` | The OpenAPI operation, by `operationId`. | object[] | SDK operations | `[{"uid": "deletePet", "type": "OpenAPI operation"}]` |
| `http_request` | The upstream request's method and URL path template, never the query. | object | SDK operations; HTTP Activity | `{"http_method": "DELETE", "url": {"path": "/pets/{petId}"}}` |
| `process`, `device` | The Deno sandbox process (`uid` is the execution id) and its host. | object | Process Activity | `{"name": "deno", "pid": 4242, "uid": "exec_…"}` |
| `app` | oag-mcp itself. | object | Application Lifecycle | `{"name": "oag-mcp", "version": "0.9.0"}` |
| `finding_info` | What was detected. | object | Detection Finding | `{"title": "Agent code sent a forged bridge message", …}` |
| `message_context` | The MCP tool call (AI Operation profile): session id, `tools/call <tool>`, and oag-mcp in the Tool role. | object | Records from a tool call | `{"name": "tools/call execute", "ai_role": "Tool", …}` |
| `action_id`, `action`, `disposition_id`, `disposition` | The decision (Security Control profile): Allowed, Denied, or Modified/Corrected when credentials the agent's code supplied were removed from an allowed request. | integer, string | Allow and deny decisions | `2`, `"Denied"`, `2`, `"Blocked"` |
| `policy.uid` | The policy that decided: an `authorization` rule id, `default`, or `implicit-allow-all` with no `authorization` section. | string | Authorization decisions | `"read-only"` |
| `unmapped` | Details OCSF has no attribute for, under their oag-mcp names (camelCase), listed per event below. | object | When there are any | `{"limit": "maxSdkCalls", "value": 200}` |
| `message` | The event name again. | string | Always | `"authorization.denied"` |

### Audit events

Every event, with its OCSF class and activity, its usual severity, and the
reason codes (`status_detail`) and `unmapped` details it carries. The
request broker records its decision on each SDK call it handles as one of
`authorization.allowed`, `authorization.denied`, `network.destination_denied`
or `credential.lookup_failed`.

| Event | Class: activity | Severity | Description | Details |
| --- | --- | --- | --- | --- |
| `authentication.mode_configured` | Application Lifecycle: Configure | Informational; Low with a warning | The MCP authentication mode at start-up. | `mode`, `validation`, `issuer`, `requiredScopes`, `principals`, `warning`, `note` |
| `authentication.succeeded` | Authentication: Logon | Informational | A caller was authenticated: once per stdio session, per request over Streamable HTTP. | `mode`, `validation`, `scopeCount` |
| `authentication.failed` | Authentication: Logon | Low | A caller was refused. | reasons such as `missing_token`, `invalid_token`, `expired`, `audience_mismatch`, `insufficient_scope`; `mode`, `validation` |
| `authentication.token_in_url_rejected` | Authentication: Logon | Low | A request carried an access token in its URL query, which is refused. | None |
| `upstream.token.issue` | Authentication: Token Issue | Informational | oag-mcp obtained an OAuth2 token for the upstream API. | `expiresInSec`, `scopeCount` |
| `upstream.token.issue_failed` | Authentication: Token Issue | Low | oag-mcp could not obtain an upstream token. | `token_request_failed`, `token_endpoint_unreachable`; `status_code` |
| `upstream.token.refresh` | Authentication: Token Refresh | Informational | oag-mcp replaced an expiring upstream token. | `expiresInSec`, `scopeCount` |
| `upstream.token.refresh_failed` | Authentication: Token Refresh | Low | oag-mcp could not replace an upstream token. | as `upstream.token.issue_failed` |
| `upstream.token.invalidated` | Authentication: Token Invalidate | Informational | A cached upstream token was discarded after the API rejected it. | reason |
| `authorization.policy_loaded` | Application Lifecycle: Configure | Informational | The authorization policy at start-up. | `policyMode` (`configured` or `implicit-allow-all`), `rules`, `default` |
| `authorization.allowed` | API Activity: Create, Read, Update or Delete | Informational | An SDK call was allowed and sent, with credentials applied. | `rule_allow`, `default_allow`, `no_policy_configured`; `provider`, `schemes`, `unauthenticated`, `strippedCredentials` |
| `authorization.denied` | API Activity: Create, Read, Update or Delete | Low | An SDK call was refused by the `authorization` policy. | `rule_deny`, `default_deny` |
| `credential.provider.configured` | Application Lifecycle: Configure | Informational | Upstream credentials were resolved at start-up. | `provider`, `schemes`, `sharedIdentity` |
| `credential.config_invalid` | Application Lifecycle: Start | High | Start-up was refused: the `upstreamAuth` configuration is invalid. | `provider`, `problems` (scheme names) |
| `credential.lookup_failed` | API Activity: Create, Read, Update or Delete | Low | An SDK call was refused: no usable upstream credentials. | `credential_not_configured`, `unsupported_scheme`, `token_request_failed`, `token_endpoint_unreachable`; `provider` |
| `execution.policy.applied` | Application Lifecycle: Configure | Informational | The sandbox and network policy at start-up. | `upstreamOrigin`, `extraRedirectOrigins`, `followRedirects`, `timeoutMs`, `memoryMb`, `maxConcurrent`, `sandbox` |
| `execution.requested` | API Activity: Execute | Informational | An `execute` call was accepted. | `language`, `codeBytes` |
| `execution.import_denied` | API Activity: Execute | Low | Code with imports was refused before running. | `violations` |
| `execution.resource_limit` | API Activity: Execute (code size, concurrency, result); the SDK call's activity (request or response size); Process Activity: Limit (memory, SDK calls, sandbox output) | Low | A limit was enforced. | `limit` (the setting, such as `maxSdkCalls`), `value` |
| `execution.capability_denied` | Process Activity: Capability Request | Low | The sandbox denied a capability. | `capability` |
| `execution.timeout` | Process Activity: Terminate | Low | An execution reached its time limit. | `wall_clock_timeout`; `timeoutMs` |
| `executor.terminated` | Process Activity: Terminate | Low | The sandbox process was killed. | reasons such as `timeout`, `output_limit`; `executor` |
| `execution.boundary_violation` | Detection Finding: Create | Medium | Agent code sent the host a message that did not come from an SDK method. | `unknown_binding`; `binding` |
| `network.destination_denied` | HTTP Activity: the request's method | Low | An upstream request did not match its operation on the configured base URL. | `origin_not_allowed`, `method_mismatch`, `path_mismatch`, `invalid_url` |
| `network.redirect_denied` | HTTP Activity: the request's method | Low | An upstream redirect was not followed. | `redirects_disabled`, `too_many_redirects`, `origin_not_allowed` |
| `transport.host_rejected` | HTTP Activity: the request's method | Low | An inbound request's `Host` is not allowed (`http.allowedHosts`). | `host_not_allowed` |
| `transport.origin_rejected` | HTTP Activity: the request's method | Low | An inbound request's `Origin` is not allowed (`http.allowedOrigins`). | `origin_not_allowed` |
| `security.config_invalid` | Application Lifecycle: Start | High | Start-up was refused: a security setting is invalid. | `status_code`; `area` |
| `security.unauthenticated_nonloopback_refused` | Application Lifecycle: Start | High | Start-up was refused: Streamable HTTP on a non-loopback address without `mcpAuth`. | `host`, `mode` |
