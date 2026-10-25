<!-- BEGIN:AVATAR -->
To be populated by generator-node typescript-cli-partials
<!-- END:AVATAR -->

<!-- BEGIN:BADGES -->
To be populated by generator-node typescript-cli-partials
<!-- END:BADGES -->

# OAG-MCP

OAG-MCP turns an OpenAPI spec and its OAG-generated SDK into a code-mode MCP server at runtime. Instead of exposing hundreds of endpoints as individual tools, it exposes two: search, for discovering operations from the spec, and execute, which runs agent-written code against your SDK in a sandbox. The SDK stays on the host with your credentials, which are applied from the spec’s security schemes, so secrets never enter the sandbox. Point it at a spec and an SDK, and your whole API is agent-ready in a few hundred tokens of context.

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio
```

## Why oag-mcp

Most OpenAPI-to-MCP bridges expose one MCP tool per endpoint, or a generic
HTTP request tool. oag-mcp takes a different approach — **SDK-backed code
mode**:

- **OpenAPI supplies the contract and documentation**: descriptions, tags,
  parameters, schemas, examples and security requirements.
- **The generated typescript-fetch SDK supplies the callable interface**:
  the exact classes, methods, signatures and model types.
- **`search`** discovers relevant SDK methods with their signatures,
  referenced types, auth requirements and a ready-to-run example.
- **`execute`** runs agent-written TypeScript that composes real SDK calls —
  loops, filtering, aggregation, `Promise.all` — inside an isolated Deno
  sandbox, and returns only the compact result.
- **The SDK stays an ordinary package** that your applications and CLIs keep
  using directly; oag-mcp only reads it.
- **MCP sees two tools**, not one per endpoint, so large APIs don't flood the
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

| Requirement | Needed for | Notes |
| --- | --- | --- |
| Node.js 22+ | everything | |
| Deno 2.x | `execute`, and checking the SDK bundle at start-up | Installed automatically through the `deno` npm dependency; or set `OAG_MCP_DENO_PATH` / put `deno` on `PATH`. |
| A typescript-fetch SDK | everything | Generated with [OpenAPI Generator](https://openapi-generator.tech)'s `typescript-fetch` generator, version 7.26.0. |

oag-mcp serves the SDK you give it; generating that SDK is done with
OpenAPI Generator itself, so the machine running the server needs neither
Docker nor OpenAPI Generator. No account, licence, cloud service or
telemetry is involved; while running, the server only connects to your API and
to any OAuth endpoints you configure.

## Quick start

### 1. Generate a typescript-fetch SDK

Generate the SDK from your OpenAPI document with OpenAPI Generator's official
Docker image:

```bash
docker run --rm -v "$PWD":/local openapitools/openapi-generator-cli:v7.26.0 \
  generate \
  --input-spec /local/openapi.yaml \
  --generator-name typescript-fetch \
  --output /local/generated-sdk
```

The SDK can be used as that directory or packed into an npm archive. To pack
it, generate it with `--additional-properties npmName=<name>,npmVersion=<version>`
(so it has a `package.json`), then in the SDK directory run:

```bash
npm install && npm pack
```

`npm pack` runs the SDK's own build script, which needs its TypeScript dev
dependency, hence the `npm install`; the archive contains both the sources
and the compiled JavaScript.

The `gen-sdk` target in [`Makefile-extras`](Makefile-extras) is an example of
both steps in a Makefile. It writes the SDK to `stage/generated-sdk/` and the
archive to `stage/<SDK_NAME>-<SDK_VERSION>.tgz`:

```bash
make -f Makefile-extras gen-sdk SPEC=path/to/openapi.yaml \
  SDK_NAME=petstore-sdk SDK_VERSION=1.0.0
```

### 2. Serve it

```bash
# stdio, for MCP clients that launch the server themselves
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio

# Streamable HTTP
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --transport streamable-http --port 3000

# from a packaged SDK
oag-mcp serve --spec ./openapi.yaml --sdk ./petstore-sdk-1.0.0.tgz --transport stdio
```

On start-up oag-mcp checks that the SDK is compatible, prepares it for the
sandbox and indexes its methods — typically in one to three seconds — and
only then accepts MCP requests. If anything cannot be prepared, it exits with
an error code and a hint explaining what to fix, rather than starting a
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

### 3. Configure credentials and access (optional)

```yaml
# oag-mcp.config.yaml — contains references to secrets, never secret values
upstream:
  baseUrl: https://api.example.com/v1   # default: the spec's first absolute server URL
upstreamAuth:
  schemes:
    apiKeyHeader:            # security scheme name from the OpenAPI document
      apiKey: { env: PETSTORE_API_KEY }
```

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --config ./oag-mcp.config.yaml
```

Secrets are resolved at start-up from environment variables or a `0600`
secrets file. They are never accepted as CLI arguments and never written to
the method index, the prepared SDK bundle, logs or anything agent code can
read. See [authentication](docs/authentication.md) for MCP access control
(`mcpAuth`), upstream credentials (`upstreamAuth`) and per-operation
`authorization`, and the [configuration reference](docs/configuration.md)
for every option.

## How serving works

- **Inputs are read once per process.** The method index, SDK bindings and
  sandbox bundle are built at start-up and stay fixed while the server runs.
  After regenerating the SDK or editing the spec, restart oag-mcp.
- **Your SDK is only read.** oag-mcp never writes to the SDK directory, never
  installs packages and never runs package or build scripts. If the SDK
  declares runtime dependencies, install them in it yourself
  (`npm install --omit=dev --ignore-scripts`); otherwise start-up stops with
  `SDK_DEPENDENCIES_MISSING` and tells you which packages are missing.
- **Source and compiled SDKs both work.** Sources (`src/*.ts`) are compiled
  by oag-mcp; compiled packages (`dist/*.js` with `.d.ts`) are used as they
  are. See [SDK compatibility](docs/sdk-compatibility.md) for supported
  generator versions, options and layouts.
- **Temporary files clean themselves up.** Prepared output (declarations, the
  sandbox bundle, an extracted archive) lives in a private `oag-mcp-ws-*`
  directory under the OS temporary directory (`TMPDIR`). It is removed when
  the server stops or fails to start, and anything left by a killed process
  is removed on the next start. There is no persistent cache to manage.

## The two tools

### `search`

```jsonc
// browse when the vocabulary is unknown
{ }
// ranked full-text search
{ "query": "vet visits of a pet" }
// full detail for one method
{ "id": "PetsApi.listPetVisits" }
```

A detail result (abridged):

```json
{
  "method": {
    "id": "PetsApi.listPetVisits",
    "sdkPath": "sdk.PetsApi.listPetVisits",
    "operationId": "list-pet-visits",
    "httpMethod": "GET",
    "path": "/pets/{petId}/visits",
    "signature": "listPetVisits(requestParameters: ListPetVisitsRequest, initOverrides?: RequestInit | runtime.InitOverrideFunction): Promise<Array<Visit>>",
    "requiredArguments": ["petId"],
    "inputType": "interface ListPetVisitsRequest {\n  petId: number; // Identifier of the pet\n  since?: Date; // Only visits on or after this date\n}",
    "referencedTypes": ["interface Visit {\n  id: number;\n  date: Date;\n  reason: string;\n  costCents?: number;\n}"],
    "auth": "apiKeyHeader(apiKey-header) OR bearerAuth(http-bearer)",
    "example": "const result = await sdk.PetsApi.listPetVisits({ petId: 1 });\nreturn result;"
  }
}
```

The binding is the SDK's own method name (`listPetVisits`), not the
operationId (`list-pet-visits`): oag-mcp reads the mapping from the generated
code rather than assuming they are equal.

### `execute`

The agent writes the body of an async function; `sdk` is provided:

```ts
const pets = await sdk.PetsApi.listPets({});
const unvaccinated = pets.filter((p) => !p.vaccinated);
const visits = await Promise.all(
  unvaccinated.map((p) => sdk.PetsApi.listPetVisits({ petId: p.id })),
);
return unvaccinated.map((p, i) => ({
  pet: p.name,
  spentCents: visits[i].reduce((s, v) => s + (v.costCents ?? 0), 0),
}));
```

Result:

```json
{
  "ok": true,
  "result": [
    { "pet": "Biscuit", "spentCents": 8100 },
    { "pet": "Nori", "spentCents": 8400 },
    { "pet": "Tofu", "spentCents": 8700 },
    { "pet": "Pip", "spentCents": 9000 }
  ],
  "logs": [],
  "stats": { "durationMs": 131, "sdkCalls": 5 }
}
```

TypeScript is type-checked against the SDK declarations before it runs.
Failures are structured: `syntax_error`, `type_error` (with line/column
diagnostics), `api_error` (HTTP status and body), `sdk_error`,
`upstream_auth_error`, `permission_denied`, `timeout`, `output_limit`,
`resource_limit`, `unsupported_result`.

## Documentation

- [Architecture](docs/architecture.md) — start-up preparation, execution model, design choices
- [SDK compatibility](docs/sdk-compatibility.md) — supported versions, options, package layouts, dependencies
- [Configuration reference](docs/configuration.md)
- [Authentication and authorization](docs/authentication.md) — `mcpAuth`, `upstreamAuth`, permissions
- [Execution sandbox and limits](docs/security.md) — what is and is not isolated
- [Logging](docs/logging.md) — operational records (OpenTelemetry) and security audit records (OCSF)
- [Deployment](docs/deployment.md)
- [Testing](docs/testing.md)

## Colophon

<!-- BEGIN:DEVELOPERS_GUIDE -->
To be populated by generator-node typescript-cli-partials
<!-- END:DEVELOPERS_GUIDE -->

<!-- BEGIN:BUILD_REPORTS -->
To be populated by generator-node typescript-cli-partials
<!-- END:BUILD_REPORTS -->
