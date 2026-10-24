# Logging

oag-mcp logs structured JSON with [Pino](https://getpino.io). Every record has
a stable `event` name and a `logCategory`:

| `logCategory` | Contents | Level control |
| --- | --- | --- |
| `operational` | CLI commands, start-up preparation stages and durations, compatibility failures, readiness, workspace cleanup, transports, search/execution lifecycle and durations, upstream call outcomes and latency | `--log-level` / `logging.level` |
| `security_audit` | authentication, token validation and refresh, authorization decisions (one per attempted SDK operation), credential provider selection and lookup failures, execution policy, denied capabilities/imports/destinations/redirects, resource limits, timeouts, forced termination, invalid security configuration | **always written** at `info`+; never sampled; unaffected by `--log-level` |

Do not rely on severity or message text to tell them apart: filter on
`logCategory`.

Example records:

```json
{"level":"warn","severity":"WARN","time":"2026-10-22T09:00:00.000Z","service":"oag-mcp","version":"0.9.0","instanceId":"inst_…","requestId":"req_…","executionId":"exec_…","transport":"streamable-http","principalId":"static:reader","operation":"AdminApi.deletePet","operationId":"deletePet","policyId":"default","reason":"default_deny","logCategory":"security_audit","event":"authorization.denied","outcome":"denied","message":"authorization.denied"}
{"level":"info","severity":"INFO","time":"…","service":"oag-mcp","version":"0.9.0","requestId":"req_…","executionId":"exec_…","operation":"PetsApi.listPets","httpMethod":"GET","pathTemplate":"/pets","status":200,"durationMs":14,"responseBytes":1180,"outcome":"success","logCategory":"operational","event":"upstream.call.completed","message":"upstream.call.completed"}
```

Common fields: `time`, `level`, `severity`, `service`, `version`,
`instanceId` (one per server process), `requestId`, `executionId`, `transport`, `principalId`,
`durationMs`, `outcome`. Correlation ids flow from the MCP request through
the execution to each SDK call and its audit records.

## Destinations

```bash
# both categories to stderr as one JSON stream (default)
oag-mcp serve --spec openapi.yaml --sdk ./sdk --transport stdio 2>oag-mcp.log
jq 'select(.logCategory == "security_audit")' oag-mcp.log

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

For stdio MCP, stdout carries **only** protocol messages, including while
the SDK is being prepared at start-up: logs (including pretty output) and
start-up errors go to stderr or files, the TypeScript compiler and esbuild
run silently, and the Deno verification run's output is captured.
`stdout`/`fd:1` are refused as log destinations.

Files are opened in append mode with `0600` permissions. Writes are
synchronous so failures are detected immediately and logs are flushed on
graceful shutdown (`SIGINT`/`SIGTERM`).

## Audit destination failures

If an audit record cannot be written, oag-mcp reports
`logging.destination_failed` directly to stderr (without recursing into the
logger). With `--audit-fail-closed` (`logging.auditFailClosed: true`),
`execute` calls are then refused with `audit_unavailable` until restart.
`search` continues to work.

Local files are not tamper-proof storage. For audit integrity, forward records
to a user-managed collector or append-only store (journald, Vector,
Fluent Bit, a SIEM).

## Redaction

- A structural sanitizer, applied to every record, censors keys such as
  `authorization`, `cookie`, `password`, `token`, `apiKey`, `client_secret`
  at any depth and in any letter case.
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
`prepare.stage.started|completed|failed` (`stage`: `inputs`,
`compatibility`, `sdk`, `index`, `executor`; with `durationMs`),
`prepare.spec.loaded`, `prepare.sdk.resolved`, `prepare.compat.checked`,
`prepare.compat.failed`, `prepare.sdk.bundled`, `prepare.index.created`,
`prepare.warning`, `prepare.sdk.prepared` (total preparation `durationMs`,
input hashes), `prepare.aborted`, `prepare.failed`, `prepare.workspace.stale_removed`,
`prepare.workspace.removed`, `prepare.workspace.cleaned`,
`prepare.workspace.cleanup_failed`, `executor.runtime.resolved`,
`executor.verified`, `tools.registered`, `transport.initialized`,
`transport.remote_exposure`, `transport.connection_failed`,
`transport.request_failed`, `transport.error`, `server.ready` (with
`startupDurationMs`), `server.shutdown_requested` (`signal` includes
`stdin_closed`; `phase`: `starting` or `serving`), `server.stopped`, `typecheck.warmed`, `search.completed`,
`execution.started|completed|failed`,
`upstream.call.completed|failed|redirected`, `upstream.token.cache_hit`,
`logging.destination_failed`.

Security audit: `authentication.mode_configured`, `authentication.succeeded`,
`authentication.failed`, `authentication.token_in_url_rejected`,
`token.validated`, `token.validation_failed`,
`upstream.token.issue|refresh|issue_failed|refresh_failed|invalidated`,
`authorization.policy_loaded`, `authorization.allowed`,
`authorization.denied`, `credential.provider.configured`,
`credential.config_invalid`, `credential.resolved`,
`credential.lookup_failed`, `credential.agent_supplied_stripped`,
`execution.policy.applied`, `execution.requested`,
`execution.import_denied`, `execution.capability_denied`,
`execution.resource_limit`, `execution.timeout`, `executor.terminated`,
`execution.boundary_violation`, `network.destination_denied`,
`network.redirect_denied`, `transport.host_rejected`,
`transport.origin_rejected`, `security.config_invalid`,
`security.unauthenticated_nonloopback_refused`.
