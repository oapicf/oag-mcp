# Architecture

`oag-mcp serve --spec <openapi> --sdk <typescript-fetch SDK>` is a single
process with two phases: **start-up preparation**, run once, turns the spec
and SDK into an in-memory method index and a sandbox-ready SDK bundle; the
**serving** phase exposes two MCP tools over stdio or Streamable HTTP and
reuses that preparation for every session and call.

## Components

| Component | Modules | Responsibility |
| --- | --- | --- |
| Start-up preparation | `lib/prepare/prepare.ts`, `workspace.ts` | Run the preparation stages in order with logging; own the private temporary workspace and its cleanup. |
| SDK adapter and compatibility | `lib/prepare/sdk-input.ts`, `compat.ts`, `bundle.ts` | Resolve directory inputs in place (read-only) and extract archives safely, reject unsupported generators/versions/options/layouts and missing dependencies, bundle the SDK for Deno, emit or copy declarations. |
| Method indexing and search | `lib/prepare/spec.ts`, `analyze.ts`, `index-builder.ts`, `lib/search/search-index.ts` | Parse OpenAPI, statically map SDK methods to operations, extract signatures and types, build and query the in-memory MiniSearch index (English stop words from `stopword`, Porter stemming from `stemmer`). |
| MCP transport and tool handlers | `lib/runtime/mcp-server.ts`, `serve.ts`, `lib/auth/mcp-auth.ts` | Register `search`/`execute`, stdio and Streamable HTTP, MCP access control. |
| Execution and SDK initialisation | `lib/executor/*`, `assets/deno-runner.js`, `lib/upstream/*` | Code policy, type checking, the Deno subprocess executor, the SDK-shaped bridge, the trusted request broker and upstream credential providers. |
| Cross-cutting | `lib/logger.ts`, `lib/util/redact.ts`, `lib/config/*`, `lib/runtime/service.ts` | Pino logging and redaction, runtime configuration, assembling the runtime. |

Boundaries are interfaces rather than a plugin system:

- `Executor` (`lib/executor/types.ts`) is all the tools depend on; the Deno
  executor can be replaced without touching search.
- `CredentialProvider` (`lib/upstream/types.ts`) receives the request
  principal, so a per-caller provider can be added later.
- The SDK adapter (compat + analyze) is the only code that knows the
  typescript-fetch layout; other generators would add sibling adapters.

The convention for where types live (contracts in `<module>/types.ts`,
shared data in `lib/types.ts`, and so on) is in
[AGENTS-extras.md](../AGENTS-extras.md#where-types-live).

## Start-up preparation

`serve` runs these stages before accepting any MCP request
(`prepare.stage.completed` is logged for each, with its duration):

1. **inputs**: load the spec with `@apidevtools/swagger-parser` (OpenAPI
   3.0/3.1, local `$ref`s only — HTTP resolution is disabled). Resolve the
   SDK: a directory is used **in place and read-only**; an `npm pack`
   archive is safely extracted into the workspace.
2. **compatibility** (`inspectSdk`): typescript-fetch runtime markers,
   recorded generator version in the tested set, supported options, layout
   (`src/*.ts` sources or `dist/*.js` + `.d.ts`), and that every runtime
   dependency in `package.json` resolves from the SDK's (or a parent's)
   `node_modules`. Nothing is installed and no package script runs.
3. **sdk**: declarations are emitted with the TypeScript compiler API
   (sources) or copied (compiled packages) into the workspace; esbuild
   writes one ES module (`sdk/sdk.bundle.js`) with all SDK runtime
   dependencies inlined. A CommonJS entry gets a small ESM re-export shim,
   also written in the workspace. TypeScript lib files and the Deno runner
   are copied next to them.
4. **index**: each API class's `<method>RequestOpts` (7.x) or
   `<method>Raw` (older output) is parsed for the HTTP method and path
   template literal, then matched to the OpenAPI operation by
   `METHOD + path`. Methods with no binding, no matching operation, or
   several matching operations stop start-up — nothing is guessed, and
   `operationId` is never assumed to equal the method name. Signatures,
   docs and referenced type declarations come from the type checker; OpenAPI
   descriptions, parameters, schemas, examples and security are merged in.
   The records, the MiniSearch index and the `sdk` binding declaration are
   held in memory (the declaration also in the workspace, for the type
   checker).
5. **executor** (`OagMcpService.create`): credential provider, authorization
   policy, request broker, Deno runtime resolution, and a verification run
   that loads the bundle in the sandbox and checks that every binding exists.
6. The fixed `search` and `execute` tools are registered (descriptions are
   computed once).
7. The transport starts; `server.ready` is logged with the total start-up
   duration.

Any failure logs `prepare.stage.failed`/`prepare.failed`, removes the
workspace and exits non-zero with an `Error [CODE]: … Hint: …` message on
stderr. Nothing is served partially.

### The workspace

A `mkdtemp` directory `oag-mcp-ws-*` (mode `0700`) under the OS temporary
directory holds `sdk/` (bundle, declarations, binding declaration, TS libs),
`executor/runner.js`, and `input/` for an extracted archive. It contains no
secrets (credentials are resolved later, host-side) and nothing in it needs
to be managed by the user: it is removed on `SIGINT`/`SIGTERM`, when a stdio client closes
stdin, on start-up failure and, as a last resort, on process exit. Signal
handlers are installed before preparation begins: a signal during start-up
cancels preparation at the next stage boundary (`STARTUP_ABORTED`, exit
code 1) and the workspace is removed by the normal failure path; a second
signal exits immediately. Each workspace records its owner PID; a later start removes workspaces whose
process no longer exists (e.g. after `SIGKILL`).

### Caching

There is no persistent cache: preparation of typical SDKs takes one to a few
seconds, and a cache would have to be keyed on the spec, SDK contents,
adapter version and settings and integrity-checked before its bundle is run.
That trade-off may be revisited for very large SDKs.

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
  through `tsx` (Mocha configuration in `package.json`, so Suntory dotfile
  updates cannot remove it). Unit tests use local fixture files;
  integration tests (`test-integration/*.ts`) add a mock API and a local
  authorisation server. The cmdt `commands.yml` smoke tests cover the `serve`
  command instead of the sample command. `.bob.json` runs unit tests via `npm test`.
- **Lint/format**: `eslint.config.js` now uses `typescript-eslint`; Prettier
  config ignores fixtures and build output.
- **Packaging**: `package.json` gained `exports`, `files`, `types`,
  pinned dependencies, scripts and Node 22+. `.gitignore` ignores `dist/`.
- **CI**: the workflow keeps `make deps`/`make ci` and adds an
  `npm run test:integration` step.
- **Makefile-extras**: a `gen-sdk` target generates a typescript-fetch SDK
  with OpenAPI Generator's Docker image and packs it with `npm pack`
  (`make -f Makefile-extras gen-sdk SPEC=path/to/openapi.yaml`).
- **Changelog**: the template's CHANGELOG contained another project's
  release history; it was replaced with this project's.
