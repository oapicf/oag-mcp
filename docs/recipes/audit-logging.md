# Audit logging

OAG-MCP writes a security audit record for everything that matters to
security: callers authenticating, each SDK call allowed or denied, credentials
applied, limits enforced, and the security settings in force at start-up.
This recipe sends those records somewhere they are kept and watched: a file
of their own, a log shipper, or a SIEM.

Audit records differ from operational logs in three ways that shape where
they go:

- They are [OCSF](https://ocsf.io/) 1.9.0 events, the schema security data
  lakes and SIEMs such as Amazon Security Lake take in, so they can be loaded
  without custom parsing.
- They are always written, whatever `--log-level` says, and never sampled.
- Writing them can be made a condition of running code: with fail-closed
  auditing, `execute` stops while records cannot be written.

By default they share stderr with the operational logs; see
[Log events](../reference/log-events.md) for both formats.

## Configuration

Audit logging is set with command-line flags or the `logging` section of the
configuration file, and the flags win:

| Flag | Configuration | Default | Use |
| --- | --- | --- | --- |
| `--audit-log-file <path>` or `fd:N` | `logging.auditFile` | stderr | Where audit records go. |
| `--audit-fail-closed` | `logging.auditFailClosed: true` | off | Refuse `execute` while audit records cannot be written. |
| `--log-file <path>` or `fd:N` | `logging.file` | stderr | Where operational records go. |
| `--log-level <level>` | `logging.level` | `info` | Operational records only; audit records ignore it. |

```yaml
logging:
  auditFile: /var/log/oag-mcp/audit.log
  auditFailClosed: true
  file: /var/log/oag-mcp/operational.log
  level: warn
```

Files are opened for appending, created with `0600` permissions, and written
synchronously, one JSON object per line. A relative path is resolved from the
working directory, not from the configuration file.

## A file of their own

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --config ./oag-mcp.yaml \
  --audit-log-file /var/log/oag-mcp/audit.log --audit-fail-closed \
  --log-file /var/log/oag-mcp/operational.log --log-level warn
```

With `--log-level warn`, the operational file stays empty until something
goes wrong, while the audit file records every call. Two calls, one allowed
and one denied by a read-only policy, give this audit file:

```text
credential.provider.configured
authorization.policy_loaded
execution.policy.applied
authentication.succeeded
execution.requested
authorization.allowed
execution.requested
authorization.denied
```

Pick out events with `jq`, for example every denial and who was denied:

```bash
jq -c 'select(.action == "Denied") | {time_dt, event: .metadata.event_code, caller: .actor.user.uid, operation: .api.operation, policy: .policy.uid}' \
  /var/log/oag-mcp/audit.log
```

### Rotating the file

OAG-MCP keeps its log files open and does not reopen them, so rotate them by
copying and truncating, not by renaming. Because the file is opened for
appending, writing carries on at the start of the truncated file. With
logrotate:

```text
/var/log/oag-mcp/*.log {
  daily
  rotate 30
  compress
  missingok
  copytruncate
}
```

Do not send OAG-MCP `SIGHUP`, as some logrotate configurations do to make a
program reopen its files: OAG-MCP does not handle it, so the process exits at
once, without shutting down cleanly. `copytruncate` can lose the few records
written between the copy and the truncation; to keep every record, forward
them instead.

## Forwarding to a shipper or SIEM

To hand records straight to a log shipper such as
[Vector](https://vector.dev/) or [Fluent Bit](https://fluentbit.io/), give
OAG-MCP a file descriptor instead of a path. Each record is written to it as
one line of JSON, as it happens:

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --config ./oag-mcp.yaml \
  --audit-log-file fd:3 --audit-fail-closed \
  3> >(vector --config ./vector.toml)
```

The shipper, configured with a standard-input source (`stdin` in Vector and
Fluent Bit), receives the OCSF events and sends them on. A
file descriptor is also how to keep audit records off a disk you do not
trust: they go from OAG-MCP to the shipper through a pipe.

The other common setups need no special support from OAG-MCP:

- **Container platforms** collect stderr. Keep the audit records on stderr
  (the default), send operational records to a file or turn them down with
  `--log-level`, and select audit records downstream by their `class_uid`
  field.
- **A shipper tailing files**, such as Fluent Bit's `tail` input or Vector's
  `file` source, reads `audit.log` as it grows.
- **journald**: run OAG-MCP as a systemd service with stderr going to the
  journal.

Local files are not tamper-proof. For an audit trail that must survive a
compromised host, forward records to an append-only store or SIEM that the
host cannot rewrite.

## When the audit destination fails

If OAG-MCP cannot open the audit file at start-up, or a write to it fails
later, it reports the failure on stderr, directly, as an operational record:

```json
{
  "SeverityText": "ERROR",
  "EventName": "logging.destination_open_failed",
  "Attributes": {
    "oag_mcp.destination": "security_audit",
    "error.type": "ENOENT",
    "oag_mcp.fail_closed": true,
    "oag_mcp.outcome": "failure"
  }
}
```

What happens next depends on fail-closed auditing:

| | `search` | `execute` |
| --- | --- | --- |
| Fail-closed (`--audit-fail-closed`) | Works | Refused until OAG-MCP is restarted with a working destination |
| Default | Works | Works, unaudited |

With fail-closed auditing, the agent receives:

```json
{
  "type": "audit_unavailable",
  "message": "Execution is disabled because required security auditing is unavailable"
}
```

`search` keeps working because it only reads the method index: it makes no
API calls and runs no code. Use fail-closed auditing wherever an unaudited
API call would be a compliance problem; leave it off where availability
matters more than a complete record.

A destination that fails while OAG-MCP is running, such as a disk that fills
up, is caught the same way: from the first failed write on, `execute` calls
are refused. When stderr is a pipe whose reader falls behind, OAG-MCP waits up to
about two seconds before counting a write as failed.

## What to watch for

Every record has `metadata.event_code`; these are the ones most worth an
alert:

| Event | Means |
| --- | --- |
| `authentication.failed`, `authentication.token_in_url_rejected` | Someone is calling with a missing, invalid or exposed token. |
| `authorization.denied` | A caller tried an operation its rules do not allow. |
| `execution.capability_denied`, `execution.import_denied` | Agent code tried to reach files, the network, the environment or modules. |
| `execution.boundary_violation` | Agent code forged a message to OAG-MCP itself: a deliberate attempt to break out. Severity Medium. |
| `network.destination_denied`, `network.redirect_denied` | A request or redirect aimed outside the configured API. |
| `credential.lookup_failed`, `upstream.token.issue_failed` | OAG-MCP has no working credentials for an operation. |
| `security.config_invalid`, `security.unauthenticated_nonloopback_refused`, `credential.config_invalid` | OAG-MCP refused to start. Severity High. |

The [log events reference](../reference/log-events.md) lists every event and
field, and [Logging](../logging.md) covers redaction and shipping operational
records to an OpenTelemetry Collector.
