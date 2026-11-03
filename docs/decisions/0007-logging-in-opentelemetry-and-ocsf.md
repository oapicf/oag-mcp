# 7. Logging in OpenTelemetry and OCSF

Status: accepted

## Context

OAG-MCP's logs serve two audiences: operators, who need to know what the
server is doing and why something failed, and security teams, who need a
complete record of who did what, loaded into a SIEM. A home-made log format
would need custom parsing in every tool that reads it.

## Decision

Operational records are OpenTelemetry log records with semantic-convention
attribute names; security audit records are OCSF events. Audit records are
always written, never sampled or filtered by the log level, and with
fail-closed auditing `execute` stops when they cannot be written. Both are
one JSON object per line, to stderr, a file or a file descriptor; stdout is
reserved for MCP.

## Consequences

- Records can be read by an OpenTelemetry Collector or loaded into
  OCSF-based stores such as Amazon Security Lake without custom parsing, and
  the audit records are validated against the OCSF schema in CI.
- Every event needs a mapping to a class and activity, and some details have
  no OCSF attribute and go under `unmapped`.
- Several of the conventions used are still marked Development by
  OpenTelemetry, so attribute names may change in later versions.
