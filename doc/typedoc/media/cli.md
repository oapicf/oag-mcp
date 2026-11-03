# CLI reference

`oag-mcp` has one command, `serve`. It takes an OpenAPI document and an
existing typescript-fetch SDK generated from it by OpenAPI Generator, and
serves them as an MCP server with two tools: `search`, to discover SDK
methods, and `execute`, to run TypeScript that calls them in a sandbox.

At start-up `serve` prepares the spec and SDK once (compatibility checks,
execution bundle, method index), then starts the transport: stdio by
default, or Streamable HTTP. If any stage fails it exits with status 1 and an
error code and hint on stderr; it never starts partially. The spec and SDK
are only read, never modified, and oag-mcp does not generate SDKs or install
packages.

Flags cover the inputs, the transport and logging. Everything else
(upstream API credentials, MCP authentication, authorization rules, execution
limits) lives in the configuration file passed with `--config`; see the
[configuration reference](../configuration.md). Where both set the same
thing, the flag wins: `--host`, `--port`, `--path` and the logging flags
override the file. Secrets are never accepted as flags.

Invalid flags are rejected before anything starts: a missing `--spec` or
`--sdk`, a value outside a flag's choices, a `--port` outside 0–65535, or an
unexpected argument. The logging flags belong to `oag-mcp` itself and can be
given before or after `serve`.

## Help output

```text
$ oag-mcp --help
Usage: oag-mcp [options] [command]

Options:
  -V, --version                    output the version number
  --log-level <logLevel>           Operational log level (security audit records
                                   are always written), default: info (choices:
                                   "fatal", "error", "warn", "info", "debug",
                                   "trace", "silent")
  --log-format <logFormat>         Log format: json (default) or pretty
                                   (human-readable, for local development;
                                   stderr only) (choices: "json", "pretty")
  --log-file <logFile>             Write operational logs to a file path or fd:N
                                   instead of stderr
  --audit-log-file <auditLogFile>  Write security audit logs to a file path or
                                   fd:N instead of stderr
  --audit-fail-closed              Refuse execute calls while security audit
                                   records cannot be written
  -h, --help                       display help for command

Commands:
  serve [options]                  Prepare an OpenAPI document and an existing
                                   OpenAPI Generator typescript-fetch SDK, then
                                   serve them as an MCP server exposing the
                                   search and execute tools
  help [command]                   display help for command
  Examples:

    serve:
      oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio
      oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport streamable-http --port 3000
      oag-mcp serve --spec ./openapi.yaml --sdk ./petstore-sdk-1.0.0.tgz --config ./oag-mcp.config.yaml
```

```text
$ oag-mcp serve --help
Usage: oag-mcp serve [options]

Prepare an OpenAPI document and an existing OpenAPI Generator typescript-fetch
SDK, then serve them as an MCP server exposing the search and execute tools

Options:
  --spec <spec>                      OpenAPI 3.0/3.1 document (YAML or JSON),
                                     required
  --sdk <sdk>                        Existing typescript-fetch SDK: a package
                                     directory or an npm package archive (.tgz),
                                     required; never modified
  --sdk-layout <sdkLayout>           SDK layout to use: source (src/*.ts),
                                     compiled (dist/*.js + .d.ts) or auto
                                     (sources when present), default: auto
                                     (choices: "auto", "source", "compiled")
  --sdk-oag-version <sdkOagVersion>  Declare the generator version of an SDK
                                     lacking .openapi-generator/VERSION
  --allow-untested-oag-version       Proceed with an OpenAPI Generator version
                                     outside the tested set
  --transport <transport>            MCP transport, default: stdio (choices:
                                     "stdio", "streamable-http")
  --port <port>                      Streamable HTTP port, default: 3000
                                     (integer, range: 0 to 65535)
  --host <host>                      Streamable HTTP bind address, default:
                                     127.0.0.1 (loopback)
  --path <path>                      Streamable HTTP endpoint path, default:
                                     /mcp
  --config <config>                  Configuration file (YAML/JSON): upstream,
                                     upstreamAuth, mcpAuth, authorization,
                                     execution, http, logging
  -h, --help                         display help for command
```

## Flags

| Name | Description | Mandatory | Default | Example |
| --- | --- | --- | --- | --- |
| `--spec <spec>` | The OpenAPI 3.0 or 3.1 document, in YAML or JSON. The SDK must have been generated from it. | Yes | | `--spec ./openapi.yaml` |
| `--sdk <sdk>` | The typescript-fetch SDK: a package directory, or an npm package archive made with `npm pack`. It is read, never modified. | Yes | | `--sdk ./generated-sdk`, `--sdk ./petstore-sdk-1.0.0.tgz` |
| `--sdk-layout <sdkLayout>` | Which form of the SDK to use: its TypeScript sources (`src/*.ts`), its compiled package (`dist/*.js` with `.d.ts` declarations), or `auto`, which uses the sources when they are present. | No | `auto` | `--sdk-layout auto`, `--sdk-layout source`, `--sdk-layout compiled` |
| `--sdk-oag-version <sdkOagVersion>` | The OpenAPI Generator version that produced the SDK, for an SDK without `.openapi-generator/VERSION`. It must agree with that file when the file exists. | No | Read from `.openapi-generator/VERSION` | `--sdk-oag-version 7.26.0` |
| `--allow-untested-oag-version` | Start even if the SDK comes from an OpenAPI Generator version oag-mcp has not been tested with. | No | Off | `--allow-untested-oag-version` |
| `--transport <transport>` | How MCP clients connect: `stdio` for a client that starts oag-mcp as a subprocess, or `streamable-http` for an HTTP endpoint. | No | `stdio` | `--transport stdio`, `--transport streamable-http` |
| `--port <port>` | The port Streamable HTTP listens on, 0 to 65535; `0` picks a free port. Overrides `http.port` in the configuration file. | No | `3000` | `--port 3000`, `--port 0` |
| `--host <host>` | The address Streamable HTTP binds to. A non-loopback address requires `mcpAuth.mode` `static-bearer` or `oauth`. Overrides `http.host`. | No | `127.0.0.1` | `--host 127.0.0.1`, `--host 0.0.0.0` |
| `--path <path>` | The URL path of the Streamable HTTP MCP endpoint. Overrides `http.path`. | No | `/mcp` | `--path /mcp` |
| `--config <config>` | The configuration file, in YAML or JSON: `upstream`, `upstreamAuth`, `mcpAuth`, `authorization`, `execution`, `http` and `logging`. Relative paths in it are resolved from the file's directory. | No | None: built-in defaults | `--config ./oag-mcp.config.yaml` |
| `--log-level <logLevel>` | The level of operational (OpenTelemetry) records. Security audit records are written whatever the level. Overrides `logging.level`. | No | `info` | `--log-level fatal`, `--log-level error`, `--log-level warn`, `--log-level info`, `--log-level debug`, `--log-level trace`, `--log-level silent` |
| `--log-format <logFormat>` | `json` writes one record per line; `pretty` writes readable lines for local development, and applies only to stderr. Overrides `logging.format`. | No | `json` | `--log-format json`, `--log-format pretty` |
| `--log-file <logFile>` | Where operational records go: a file path, or `fd:N` for an open file descriptor. stdout is refused, because it carries MCP traffic over stdio. Overrides `logging.file`. | No | stderr | `--log-file /var/log/oag-mcp/operational.log`, `--log-file fd:3` |
| `--audit-log-file <auditLogFile>` | Where security audit (OCSF) records go: a file path or `fd:N`. stdout is refused. Overrides `logging.auditFile`. | No | stderr | `--audit-log-file /var/log/oag-mcp/audit.log`, `--audit-log-file fd:4` |
| `--audit-fail-closed` | Refuse `execute` calls while security audit records cannot be written. Also enabled by `logging.auditFailClosed: true`; the flag cannot turn it off. | No | Off | `--audit-fail-closed` |
| `-h`, `--help` | Show help: for `oag-mcp`, or for `serve` when given after it. | No | | `--help`, `serve --help` |
| `-V`, `--version` | Show the oag-mcp version. | No | | `--version` |
