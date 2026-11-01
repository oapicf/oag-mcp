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

Point OAG-MCP at a spec and an SDK, and your whole API is agent-ready in a few hundred tokens of context.

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport streamable-http --port 3000
```

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

```text
                    oag-mcp serve (one process)
 openapi.yaml ─┐   ┌──────────────── start-up, once ────────────────┐
               ├──▶│ 1 inputs  2 compatibility  3 bundle + .d.ts     │
 SDK dir/.tgz ─┘   │ 4 method index  5 bridge + Deno executor        │
  (read-only)      │ 6 register search/execute  7 start transport    │
                   └───────────────────────┬─────────────────────────┘
                                           ▼  (stdio or Streamable HTTP)
                    search ─▶ in-memory index
                    execute ─▶ type check ─▶ Deno sandbox (real SDK) ──┐
                               host broker: authz, network, credentials ◀┘ ─▶ your API
```

## Installation

```bash
npm install -g oag-mcp
```

## Requirements

* Node.js 22+ - For running oag-mcp command.
* Deno 2.x - Installed automatically through the `deno` npm dependency; or set `OAG_MCP_DENO_PATH` / put `deno` on `PATH`.
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
sandbox and indexes its methods — typically in one to three seconds — and
only then accepts MCP requests. If anything cannot be prepared, it exits with
[an error type](docs/reference/error-types.md) and a hint explaining what to fix, rather than starting a
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
  # default: the spec's first absolute server URL
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
(`mcpAuth`), upstream credentials (`upstreamAuth`) and per-operation
`authorization`, and the [configuration reference](docs/reference/configuration.md)
for every option.

## Learn more

* [Architecture](docs/architecture.md) — start-up preparation, execution model, design choices
* [SDK compatibility](docs/sdk-compatibility.md) — supported versions, options, package layouts, dependencies
* [Configuration reference](docs/configuration.md)
* [Authentication and authorization](docs/authentication.md) — `mcpAuth`, `upstreamAuth`, permissions
* [Execution sandbox and limits](docs/security.md) — what is and is not isolated
* [Logging](docs/logging.md) — operational records (OpenTelemetry) and security audit records (OCSF)
* [Deployment](docs/deployment.md)
* [Testing](docs/testing.md)

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
