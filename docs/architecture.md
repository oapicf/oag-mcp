# Architecture

oag-mcp has two phases: **build** prepares an SDK once into a self-contained
artifact; **serve** loads the artifact and exposes two MCP tools.

## Components

| Component | Modules | Responsibility |
| --- | --- | --- |
| SDK preparation and compatibility | `lib/build/sdk-input.ts`, `compat.ts`, `generate.ts`, `bundle.ts` | Stage directory/archive inputs safely, generate SDKs (Java/Docker), reject unsupported generators/versions/options, bundle the SDK for Deno, emit declarations. |
| Method indexing and search | `lib/build/spec.ts`, `analyze.ts`, `index-builder.ts`, `lib/search/search-index.ts` | Parse OpenAPI, statically map SDK methods to operations, extract signatures and types, build and query the MiniSearch index. |
| MCP transport and tool handlers | `lib/runtime/mcp-server.ts`, `serve.ts`, `lib/auth/mcp-auth.ts` | Register `search`/`execute`, stdio and Streamable HTTP, MCP access control. |
| Execution and SDK initialisation | `lib/executor/*`, `assets/deno-runner.js`, `lib/upstream/*` | Code policy, type checking, the Deno subprocess executor, the SDK-shaped bridge, the trusted request broker and upstream credential providers. |
| Cross-cutting | `lib/logging/*`, `lib/config/*`, `lib/runtime/service.ts` | Pino logging and redaction, runtime configuration, assembling the runtime. |

Boundaries are interfaces rather than a plugin system:

- `Executor` (`lib/executor/types.ts`) is all the tools depend on; the Deno
  executor can be replaced without touching search.
- `CredentialProvider` (`lib/upstream/credentials.ts`) receives the request
  principal, so a per-caller provider can be added later.
- The SDK adapter (compat + analyze) is the only code that knows the
  typescript-fetch layout; other generators would add sibling adapters.

## Build pipeline

1. **Load the spec** with `@apidevtools/swagger-parser` (OpenAPI 3.0/3.1,
   local `$ref`s only — HTTP resolution is disabled).
2. **Obtain the SDK**: copy a directory, safely extract an archive, or run
   OpenAPI Generator into a private work directory. The input is never
   modified.
3. **Compatibility checks** (`inspectSdk`): typescript-fetch runtime markers,
   recorded generator version in the tested set, supported options, layout
   (`src/*.ts` sources or `dist/*.js` + `.d.ts`).
4. **Declarations**: emitted with the TypeScript compiler API (sources) or
   copied (compiled packages).
5. **Binding analysis**: each API class's `<method>RequestOpts` (7.x) or
   `<method>Raw` (older output) is parsed for the HTTP method and path
   template literal, then matched to the OpenAPI operation by
   `METHOD + path`. Methods with no binding, no matching operation, or several
   matching operations are build errors — nothing is guessed. Signatures,
   docs and referenced type declarations come from the type checker.
6. **Bundle**: esbuild produces one ES module (`sdk/sdk.bundle.js`) with all
   SDK runtime dependencies inlined, for the Deno executor.
7. **Self-checks**: every generated example is type-checked against the
   binding declaration, and the bundle is loaded in the Deno sandbox to verify
   every binding exists.
8. **Artifact**: index, declarations, TypeScript lib files, runner, manifest
   with versions/options/input hashes and SHA-256 of every file.

## Execution model

```text
 MCP client ── execute(code) ──▶ oag-mcp host (Node.js, trusted)
                                  │ 1. reject imports, transpile, type-check
                                  │ 2. spawn Deno (no permissions, empty env)
                                  ▼
                      ┌──── Deno sandbox (untrusted code) ────┐
                      │  agent code ─▶ sdk.PetsApi.listPets() │
                      │  real generated SDK (bundle)          │
                      │  fetchApi = bridge  ── JSON line ─────┼──▶ broker
                      └───────────────────────────────────────┘     │
                                                                    │ authorise op (per call)
                                                                    │ check URL/method/path
                                                                    │ attach credentials
                                                                    ▼
                                                                 your API
```

The real SDK runs inside the sandbox: request building, parameter
serialisation, model conversion (`FromJSON`/`ToJSON`, dates) and error types
are the generated code's own. Only the final `fetch` is bridged to the host,
which is where credentials live. See [security](security.md).

### Alternatives considered

- **Run the SDK on the host and proxy method calls from the sandbox.** Keeps
  the SDK out of the sandbox, but means serialising SDK arguments (Dates,
  Blobs) across the boundary and running user-supplied SDK code in the server
  process. Rejected: the hybrid gives the same credential isolation with less
  machinery.
- **Give the sandbox `--allow-net=<api host>` and credentials.** Simplest, but
  credentials would be readable by agent code. Rejected.
- **`node:vm`, `isolated-vm` or QuickJS/WASM.** `node:vm` is not a security
  boundary; isolated-vm/QuickJS would need a custom host bridge for fetch,
  timers and SDK globals and are less battle-tested against this SDK's
  runtime. Deno gives a separate process, a permission model and a standard
  web runtime the SDK already targets.

## Template changes

The repository started from the `generator-node` CLI template (JavaScript,
Mocha, bagofcli, Suntory/Bob). Changes:

- **Language**: sources are TypeScript in `lib/` (template layout kept),
  compiled by `tsc` to `dist/`; `bin/oag-mcp.js` loads `dist/cli.js`. Added
  `tsconfig.json` (type-check incl. tests) and `tsconfig.build.json`.
- **Module conventions**: ES modules, `"use strict"`, JSDoc and
  `module - method` test naming are kept. The callback convention is replaced
  by `async`/`await` because the MCP SDK, fetch, esbuild and the TypeScript
  API are promise-based.
- **CLI**: still `bagofcli` with `conf/commands.json`; the sample `display`
  command, `lib/models/message.js` and `examples/oag-mcp.yaml` were removed.
- **Tests**: Mocha + Sinon + referee are kept; tests are TypeScript run
  through `tsx` (`.mocharc.json`). Unit tests use local fixture files;
  integration tests (`test-integration/*.ts`) add a mock API and a local
  authorisation server. The cmdt `commands.yml` smoke tests were rewritten for
  the new commands. `.bob.json` runs unit tests via `npm test`.
- **Lint/format**: `eslint.config.js` now uses `typescript-eslint`; Prettier
  config ignores fixtures and build output.
- **Packaging**: `package.json` gained `exports`, `files`, `types`,
  pinned dependencies, scripts and Node 22+. `.gitignore` ignores `dist/`.
- **CI**: the workflow keeps `make deps`/`make ci` and adds Java for SDK
  generation tests and an `npm run test:integration` step.
- **Changelog**: the template's CHANGELOG contained another project's
  release history; it was replaced with this project's.
