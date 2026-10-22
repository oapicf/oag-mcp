<!-- BEGIN:AVATAR -->
To be populated by generator-node node-cli-partials
<!-- END:AVATAR -->

<!-- BEGIN:BADGES -->
To be populated by generator-node node-cli-partials
<!-- END:BADGES -->

# OAG MCP

An open-source CLI that turns OpenAPI specifications and OpenAPI Generator SDKs into code-mode MCP servers, exposing searchable SDK capabilities and sandboxed SDK execution through two tools: `search` and `execute`.

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
- **The same SDK stays an ordinary package** that applications and CLIs use
  directly; oag-mcp never modifies it.
- **MCP sees two tools**, not one per endpoint, so large APIs don't flood the
  agent's context.

```text
                build (once)                         serve (per request)
 openapi.yaml ─┐                         ┌───────────────────────────────────────┐
               ├─▶ oag-mcp build ─▶ artifact ─▶ search ─▶ MiniSearch index      │
 SDK (dir/tgz  │   • compat checks         │                                     │
 or generated)─┘   • bundle + .d.ts        │  execute ─▶ type check ─▶ Deno       │
                   • method index          │            sandbox (real SDK) ──┐    │
                   • manifest + hashes     │   host broker: authz, network, ◀┘    │
                                           │   credentials ─▶ your API          │
                                           └───────────────────────────────────────┘
```

## Installation

```bash
npm install -g oag-mcp
```

Requirements:

| What | Needed for | Notes |
| --- | --- | --- |
| Node.js 22+ | everything | |
| Deno 2.x | `execute` (and build-time bundle verification) | Installed automatically through the `deno` npm dependency; or set `OAG_MCP_DENO_PATH` / put `deno` on `PATH`. |
| Java 11+ | `build --generate-sdk --oag-backend java` only | Not needed to serve. |
| Docker | `build --generate-sdk --oag-backend docker` only | Not needed to serve. |

No account, licence, cloud service or telemetry is involved. Network access is
only used for ordinary package downloads (npm, the generator JAR from Maven
Central or the generator Docker image) and for calls to your own API.

## Quick start

### 1. Build an artifact

From an existing typescript-fetch SDK (a package directory or an `npm pack`
archive):

```bash
oag-mcp build --spec ./openapi.yaml --sdk ./generated-sdk --out ./my-mcp-server
oag-mcp build --spec ./openapi.yaml --sdk ./my-sdk-1.0.0.tgz --out ./my-mcp-server
```

Or let oag-mcp generate the SDK locally with OpenAPI Generator:

```bash
oag-mcp build --spec ./openapi.yaml --generate-sdk --out ./my-mcp-server
oag-mcp build --spec ./openapi.yaml --generate-sdk \
  --oag-version 7.26.0 --oag-backend docker --out ./my-mcp-server
```

The default generator version is the exact, tested `7.26.0` (never "latest").
Tested versions are `7.25.0` and `7.26.0`. See
[SDK compatibility](docs/sdk-compatibility.md).

### 2. Configure upstream credentials (optional)

```yaml
# oag-mcp.config.yaml — contains references to secrets, never secret values
upstream:
  baseUrl: https://api.example.com/v1
upstreamAuth:
  schemes:
    apiKeyHeader:            # security scheme name from the OpenAPI document
      apiKey: { env: PETSTORE_API_KEY }
```

### 3. Serve it

```bash
oag-mcp serve ./my-mcp-server --transport stdio --config ./oag-mcp.config.yaml
oag-mcp serve ./my-mcp-server --transport streamable-http --port 3000 --config ./oag-mcp.config.yaml
```

Example MCP client entry (stdio):

```json
{
  "mcpServers": {
    "petstore": {
      "command": "oag-mcp",
      "args": ["serve", "/path/to/my-mcp-server", "--transport", "stdio", "--config", "/path/to/oag-mcp.config.yaml"],
      "env": { "PETSTORE_API_KEY": "…" }
    }
  }
}
```

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

Note that the binding is the SDK's own method name (`listPetVisits`), not the
operationId (`list-pet-visits`): oag-mcp maps them from the generated code
rather than assuming they are equal.

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

- [Architecture and template changes](docs/architecture.md)
- [SDK compatibility](docs/sdk-compatibility.md) — supported versions, options, package layouts
- [Configuration reference](docs/configuration.md)
- [Authentication and authorization](docs/authentication.md) — `mcpAuth`, `upstreamAuth`, permissions
- [Execution sandbox and limits](docs/security.md) — what is and is not isolated
- [Logging](docs/logging.md) — operational vs security audit records
- [Packaging and deployment](docs/deployment.md)
- [Testing and verification](docs/testing.md)

## Colophon

<!-- BEGIN:DEVELOPERS_GUIDE -->
To be populated by generator-node node-cli-partials
<!-- END:DEVELOPERS_GUIDE -->

<!-- BEGIN:BUILD_REPORTS -->
To be populated by generator-node node-cli-partials
<!-- END:BUILD_REPORTS -->
