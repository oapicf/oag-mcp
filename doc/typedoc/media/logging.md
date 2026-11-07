# Logging

OAG-MCP writes two kinds of log record, and each follows an open standard,
so log pipelines and SIEMs can take them in without custom parsing:

- **Operational records** are [OpenTelemetry](https://opentelemetry.io/) log
  records. They say what the server is doing and how long it takes: start-up
  preparation, transports, `search` and `execute` calls, upstream API calls,
  and failures. They are for running and debugging OAG-MCP.
- **Security audit records** are [OCSF](https://ocsf.io/) (Open Cybersecurity
  Schema Framework) 1.9.0 events. They record what matters to security:
  callers authenticating, the decision on every SDK call, credentials applied,
  limits enforced, and the security settings in force at start-up. They are
  for security monitoring and compliance.

The two kinds have different audiences and different guarantees. Operational
records follow the log level. Audit records are always written, whatever the
level, and never sampled. Why OAG-MCP uses these two standards is recorded in
[ADR 0007](decisions/0007-logging-in-opentelemetry-and-ocsf.md).

Every record is one JSON object on one line, with a stable event name:
`EventName` in operational records, `metadata.event_code` in audit records.
The [log events reference](reference/log-events.md) lists every event and
field.

## Where records go

With no log flags and no `logging` configuration, both kinds go to stderr,
interleaved in one JSON stream, with operational records at level `info` and
above. Each kind can be sent elsewhere on its own: to a file path, or to an
open file descriptor as `fd:N`.

```bash
# both kinds to stderr as one stream (the default)
oag-mcp serve --spec openapi.yaml --sdk ./sdk 2>oag-mcp.log

# a file for each kind
oag-mcp serve --spec openapi.yaml --sdk ./sdk --transport streamable-http \
  --log-file /var/log/oag-mcp/operational.log \
  --audit-log-file /var/log/oag-mcp/audit.log

# audit records to a log shipper through a file descriptor
oag-mcp serve --spec openapi.yaml --sdk ./sdk --audit-log-file fd:3 3> >(vector --config vector.toml)
```

The flags are `--log-file`, `--audit-log-file`, `--log-level`, `--log-format`
and `--audit-fail-closed`, and each has a counterpart in the `logging`
section of the configuration file; a flag overrides its counterpart. See the
[CLI reference](reference/cli.md#flags) and the
[configuration reference](reference/configuration.md).

stdout is never used for logs. With the stdio transport it carries only MCP
protocol messages, including while the SDK is being prepared at start-up:
logs and start-up errors go to stderr or files, the TypeScript compiler and
esbuild run silently, and the output of the Deno verification run is
captured. `stdout` and `fd:1` are refused as log destinations.

When both kinds share a stream, tell them apart by shape, not by level or
message text: audit records have `class_uid`, operational records have
`SeverityNumber`.

```bash
jq 'select(.SeverityNumber)' oag-mcp.log     # operational
jq 'select(.class_uid)' oag-mcp.log          # security audit
jq 'select(.metadata.event_code == "authorization.denied")' oag-mcp.log
jq 'select(.EventName == "upstream.call.completed") | .Attributes' oag-mcp.log
```

## Levels and formats

`--log-level` (`logging.level`) filters operational records only: `trace`,
`debug`, `info` (the default), `warn`, `error`, `fatal` or `silent`. `silent`
turns operational records off, and audit records carry on. A few events, such
as reusing a cached upstream token, are written only at `debug`.

Records are JSON by default. `--log-format pretty` prints one readable line
per record, with an operational record's attributes below it, for local
development. It applies only to stderr; files and file descriptors are always
JSON.

```text
[00:11:16.578] INFORMATIONAL: [security_audit] authorization.allowed API Activity: Read Allowed (default_allow)
[00:11:16.596] INFO: [operational] upstream.call.completed success
    Attributes: {
      "oag_mcp.operation": "PetsApi.listPets",
      …
    }
[00:11:16.664] LOW: [security_audit] authorization.denied API Activity: Delete Denied (rule_deny)
```

## Following a request through the logs

Records written while handling an MCP request carry its ids, in both kinds:
the request id, and for an `execute` call the execution id, which is also the
`executionId` the call returns to the agent. Every SDK call made during the
execution carries both. To see everything one call did, search for its
execution id:

```bash
jq -c 'select(tostring | contains("exec_ff046664-b386-4209-9708-5f21b3e15db3"))' oag-mcp.log
```

Each server process also has an instance id, in every record of both kinds,
which tells records from several OAG-MCP processes apart in a shared log
store. [Correlation ids](reference/log-events.md#correlation-ids) lists the
field that carries each id in each kind.

Every SDK call the agent's code attempts produces exactly one decision record
in the audit log: `authorization.allowed`, `authorization.denied`,
`network.destination_denied` or `credential.lookup_failed`. Counting them
counts attempted API calls, whatever happened next.

To find which agent made a call and what the API saw, see
[Finding the actors in the logs](identity.md#finding-the-actors-in-the-logs).

## What is never logged

Logs never contain credentials, the code the agent submits, search queries,
request or response bodies, or execution results. Records carry identifiers,
operation names, policy ids, reason codes, sizes and durations instead. Three
layers keep it that way:

- **Sensitive keys.** Before a record is written, the value of any key named
  like a credential (`authorization`, `cookie`, `password`, `token`,
  `apiKey`, `client_secret` and similar, in any letter case and at any depth)
  is replaced with a placeholder.
- **Known secrets.** Every credential OAG-MCP resolves and every token it
  obtains is registered, and scrubbed from every string written, including
  its base64 form as used by HTTP Basic authentication.
- **Credential-shaped text.** `Bearer`, `Basic` and `Digest` header values,
  JWT-shaped strings, credentials in URLs and credential-bearing query
  parameters are masked wherever they appear.

URLs are logged as a path template such as `/pets/{petId}`, never with their
query string. Long strings and deeply nested values are cut short, so a
large value cannot swell a record. [Redaction](reference/log-events.md#redaction)
lists every masked name and pattern, and the size limits.

## How records are written

Files are opened for appending and created with `0600` permissions, so only
OAG-MCP's user can read them. Writes are synchronous: a failing destination
is noticed on the write that fails, which is what lets fail-closed auditing
stop `execute` at once, and nothing is left unwritten when OAG-MCP stops on
`SIGINT` or `SIGTERM`. OAG-MCP keeps its files open and never rotates or
reopens them; [Audit logging](recipes/audit-logging.md#rotating-the-file)
shows how to rotate them from outside.

When stderr is a pipe whose reader falls behind, such as an MCP client that
reads the server's stderr slowly, OAG-MCP waits rather than dropping
records: a full pipe is retried for about two seconds. If the reader still
has not caught up, the write counts as failed, later writes fail at once
instead of waiting again, and up to 1 MiB of records not yet written is kept
and written in order once the reader catches up.

## When a destination fails

If a log file cannot be opened at start-up, or a write fails later, OAG-MCP
reports it straight to stderr as an operational record,
`logging.destination_open_failed` or `logging.destination_failed`, without
going through the failing logger.

Operational logging failures never stop the server. Audit logging failures
do, if you ask: with `--audit-fail-closed` (`logging.auditFailClosed: true`),
`execute` calls are refused with `audit_unavailable` from the first failed
audit write until OAG-MCP is restarted, so no API call goes unaudited.
`search` keeps working, since it makes no API calls. Without it, OAG-MCP
carries on unaudited. [Audit logging](recipes/audit-logging.md#when-the-audit-destination-fails)
shows both.

Local files are not tamper-proof storage. For an audit trail that must
survive a compromised host, forward the records to a collector or an
append-only store the host cannot rewrite: journald, Vector, Fluent Bit, or a
SIEM.

## Sending records on

Audit records are OCSF, the schema security data lakes and SIEMs such as
Amazon Security Lake take in. [Audit logging](recipes/audit-logging.md)
covers sending them to a file of their own, a log shipper or a SIEM.

Operational records use the field names of OpenTelemetry's
[Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/),
so the [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
(contrib distribution) can read the operational log file and turn each record
back into an OpenTelemetry log record, with its resource, scope, timestamp,
severity, event name and attributes, then export it to any OpenTelemetry
backend:

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
