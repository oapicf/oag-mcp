<!-- BEGIN:AVATAR -->
![Avatar](avatar.jpg)
<!-- END:AVATAR -->

<!-- BEGIN:BADGES -->
[![Build Status](https://github.com/oapicf/oag-mcp/workflows/CI/badge.svg)](https://github.com/oapicf/oag-mcp/actions?query=workflow%3ACI)
[![Dependencies Status](https://img.shields.io/librariesio/release/npm/oag-mcp)](https://libraries.io/npm/oag-mcp)
[![Code Scanning Status](https://github.com/oapicf/oag-mcp/workflows/CodeQL/badge.svg)](https://github.com/oapicf/oag-mcp/actions?query=workflow%3ACodeQL)
[![Coverage Status](https://coveralls.io/repos/github/oapicf/oag-mcp/badge.svg?branch=main)](https://coveralls.io/r/oapicf/oag-mcp?branch=main)
[![Security Status](https://snyk.io/test/github/oapicf/oag-mcp/badge.svg)](https://snyk.io/test/github/oapicf/oag-mcp)
[![Published Version](https://img.shields.io/npm/v/oag-mcp.svg)](https://www.npmjs.com/package/oag-mcp)
<!-- END:BADGES -->

# OAG-MCP

OAG-MCP turns an OpenAPI spec and its OAG-generated SDK into a code-mode MCP server at runtime.

Instead of exposing hundreds of endpoints as individual tools, it exposes two:

* `search` for discovering operations from the spec.
* `execute` for running agent-written code against your SDK in a sandbox.

The SDK stays on the host with your credentials, which are applied from the spec’s security schemes, so secrets never enter the sandbox.

Point OAG-MCP at a spec and an SDK, and your whole API is agent-ready in under a thousand tokens of context.

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport streamable-http --port 3000
```

https://github.com/user-attachments/assets/93b462db-4ff8-4b22-8dfd-120daa0855c9

## Why OAG-MCP

A lot of OpenAPI-to-MCP bridges expose one MCP tool per endpoint, or a generic
HTTP request tool. OAG-MCP takes a different approach by utilising **SDK-backed code
mode** where the SDK is generated out of the OpenAPI specification itself:

* **OpenAPI supplies the contract and documentation**: descriptions, tags,
  parameters, schemas, examples and security requirements.
* **The generated typescript-fetch SDK supplies the callable interface**:
  the exact classes, methods, signatures and model types.
* **`search`** discovers relevant SDK methods with their signatures,
  referenced types, auth requirements and a ready-to-run example.
* **`execute`** runs agent-written TypeScript that composes real SDK calls —
  loops, filtering, aggregation, `Promise.all` — inside an isolated Deno
  sandbox, and returns only the compact result.
* **The SDK stays an ordinary package** that your applications, CLIs, and other consumers keep
  using directly; OAG-MCP only reads it.
* **MCP sees two tools**, not one per endpoint, so large APIs don't flood the
  agent's context.

Letting an AI agent write code against a real API is only useful if it is
safe. OAG-MCP is built **security-first**: it treats agent code as untrusted
and keeps your credentials out of its reach, so you can give an agent your API
without giving it your keys or your infrastructure:

* **Credentials never reach the agent**: secrets are loaded only at run time,
  added to requests by OAG-MCP's broker outside the sandbox, and scrubbed from
  logs, errors and results.
* **Agent code runs in a locked-down sandbox**: a fresh Deno process per call,
  with no file system, network, environment or subprocess access, no
  `eval`, and limits on time, memory, output and API calls.
* **Every API call is checked**: the broker allows a request only if it
  matches the operation it claims to be, on the configured API, for a caller
  the authorisation rules allow; a deny always wins.
* **No unauthenticated remote access**: over HTTP, every request must carry a
  valid bearer or OAuth 2.0 access token; serving without one is allowed only
  on loopback. Over stdio, only the process that started OAG-MCP can reach it.
  Either way each caller gets an identity for authorisation and audit, and an
  MCP token is never forwarded to your API.
* **Safe by default**: it binds to loopback, refuses to serve a non-loopback
  address without authentication, checks `Host` and `Origin`, and never runs
  the SDK's code or install scripts on the host.
* **Everything is audited**: every security decision is a standard
  [OCSF](https://ocsf.io/) event, ready for a SIEM, with an option to stop
  executing while audit records cannot be written.

[Security](docs/security.md) describes each protection, and what is not claimed.

## Installation

```bash
npm install -g oag-mcp
```

## Requirements

* Node.js 22+ - For running the `oag-mcp` command.
* Deno 2.5 or later (2.x) - Installed automatically through the `deno` npm dependency; or set `OAG_MCP_DENO_PATH` / put `deno` on `PATH`.
* OpenAPI specification
* An SDK generated with [OpenAPI Generator](https://openapi-generator.tech)'s `typescript-fetch`.

## Quick start

### 1. Generate a typescript-fetch SDK

Generate the typescript-fetch SDK from your OpenAPI specification with OpenAPI Generator's official
Docker image:

```bash
# Name your OpenAPI specification openapi.yaml
# and place it on your current working directory.

docker run --rm -v "$PWD":/local openapitools/openapi-generator-cli:v7.26.0 \
  generate \
  --input-spec /local/openapi.yaml \
  --generator-name typescript-fetch \
  --output /local/generated-sdk
```

The generated SDK code on that directory `./generated-sdk` can be used directly and you're done for step 1.

However, as an alternative, [you can also use an npm archive packed from the generated SDK code](docs/recipes/packaged-sdk.md).

### 2. Run the MCP server

```bash
# stdio
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio

# Streamable HTTP
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --transport streamable-http --port 3000

# from a packaged SDK
oag-mcp serve --spec ./openapi.yaml --sdk ./petstore-sdk-1.0.0.tgz --transport stdio
```

On start-up OAG-MCP checks that the SDK is compatible, prepares it for the
sandbox and indexes its methods — typically in one to a few seconds — and
only then accepts MCP requests. If anything cannot be prepared, it exits with
[an error code](docs/reference/error-codes.md) and a hint explaining what to fix, rather than starting a
partially working server.

Example MCP client entry (stdio):

```json
{
  "mcpServers": {
    "petstore": {
      "command": "oag-mcp",
      "args": [
        "serve", "--spec", "/path/to/openapi.yaml", "--sdk", "/path/to/generated-sdk",
        "--transport", "stdio", "--config", "/path/to/oag-mcp.config.yaml"
      ],
      "env": { "PETSTORE_API_KEY": "…" }
    }
  }
}
```

### 3. Configure credentials and access

Create OAG-MCP configuration file:

```yaml
# oag-mcp.config.yaml — contains references to secrets, never secret values
upstream:
  # default: the spec's first server URL, which must be absolute
  baseUrl: https://api.example.com/v1
upstreamAuth:
  schemes:
    apiKeyHeader:
      # security scheme name from the OpenAPI document
      apiKey: { env: PETSTORE_API_KEY }
```

Run MCP server with the configuration file passed as `--config` arg:

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --config ./oag-mcp.config.yaml
```

Secrets are resolved at start-up from environment variables or a `0600`
secrets file. They are never accepted as CLI arguments and never written to
the method index, the prepared SDK bundle, logs or anything agent code can
read. See [authentication](docs/authentication.md) for MCP access control
(`mcpAuth`) and upstream credentials (`upstreamAuth`),
[authorisation](docs/authorisation.md) for per-operation permissions, and the [configuration reference](docs/reference/configuration.md)
for every option.

## Learn more

* [How it works](docs/how-it-works.md) — what happens, step by step, from start-up to each tool call
* [SDK compatibility](docs/sdk-compatibility.md) — supported versions, options, package layouts, dependencies
* [Architecture](docs/architecture.md) — components, start-up preparation, execution model, design choices
* [Decision records](docs/decisions/README.md) — why OAG-MCP is built the way it is
* [Security](docs/security.md) — OAG-MCP's security features, and what is not claimed
* [Authentication](docs/authentication.md) — who may call OAG-MCP (`mcpAuth`), and how it calls your API (`upstreamAuth`)
* [Authorisation](docs/authorisation.md) — what each caller may do (`authorization`)
* [Logging](docs/logging.md) — operational records (OpenTelemetry) and security audit records (OCSF)
* [Deployment](docs/deployment.md) — running OAG-MCP as a server, in a container and in production
* [Troubleshooting](docs/troubleshooting.md) — why OAG-MCP does not start, a client cannot connect, or a call failed
* [Testing](docs/testing.md) — lint checks, unit and integration tests, and extra checks
* [Releasing](docs/releasing.md) — for maintainers: packaging and publishing OAG-MCP
* [Recipes](docs/recipes/README.md) — set-ups for common situations, from configuration to logs:
   * [Read-only server](docs/recipes/read-only.md) — try OAG-MCP safely, reading but not changing anything
   * [Upstream credentials](docs/recipes/upstream-credentials.md) — API keys, bearer tokens and basic authentication
   * [Upstream OAuth2](docs/recipes/upstream-oauth.md) — OAuth2 client credentials tokens
   * [Curated operations](docs/recipes/curated.md) — expose only some of an API
   * [Per-caller permissions](docs/recipes/per-caller-permissions.md) — give each caller its own operations
   * [Execution limits](docs/recipes/execution-limits.md) — tune time, memory, result and API-call limits
   * [Remote server](docs/recipes/remote-server.md) — serve remote MCP clients over HTTPS
   * [Packaged SDK](docs/recipes/packaged-sdk.md) — deploy the SDK as a versioned archive
   * [Audit logging](docs/recipes/audit-logging.md) — keep security audit records in a file, a log shipper or a SIEM
* [Reference](docs/reference/README.md) — everything OAG-MCP accepts and produces:
   * [MCP tools](docs/reference/tools.md) — the `search` and `execute` tools
   * [CLI](docs/reference/cli.md) — the `serve` command, its flags and environment variables
   * [Configuration](docs/reference/configuration.md) — every configuration property
   * [HTTP endpoints](docs/reference/http-endpoints.md) — paths, request checks and responses
   * [Error codes](docs/reference/error-codes.md) — why OAG-MCP did not start
   * [Error types](docs/reference/error-types.md) — errors `execute` returns to the agent
   * [Log events](docs/reference/log-events.md) — every operational and security audit record

## Colophon

<!-- BEGIN:DEVELOPERS_GUIDE -->
[Developer's Guide](https://cliffano.github.io/developers-guide-typescript.html)
<!-- END:DEVELOPERS_GUIDE -->

<!-- BEGIN:BUILD_REPORTS -->
Build reports:

* [Code complexity report](https://oapicf.github.io/oag-mcp/complexity/eslint/index.html)
* [Unit tests report](https://oapicf.github.io/oag-mcp/test/mochawesome/index.html)
* [Test coverage report](https://oapicf.github.io/oag-mcp/coverage/c8/index.html)
* [Integration tests report](https://oapicf.github.io/oag-mcp/test-integration/mochawesome/index.html)
* [API Documentation](https://oapicf.github.io/oag-mcp/doc/typedoc/index.html)

<!-- END:BUILD_REPORTS -->
