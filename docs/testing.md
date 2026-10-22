# Testing and verification

```bash
npm install                 # also builds dist/ (prepare)
npm run typecheck && npm run lint && npm run style
npm test                    # unit tests (test/**/*.ts)
npm run test:integration    # integration tests (test-integration/**/*.ts)
npm run coverage
make ci                     # Suntory/Bob pipeline (needs bob, yq, mdl)
```

Mocha configuration lives in `package.json` (`"mocha"`); the integration
script passes its own flags.

No account, paid service or external network is needed by the tests except
`npm ping`/`npm install` for the packaging test. The development-only
generation tests (`test-integration/dev-generate.ts`) additionally need Java
with a cached generator JAR (or Maven Central) or Docker. Tests whose
prerequisites are missing are **skipped and print `[blocked: <reason>]`**
rather than passing silently.

## Fixtures

- `test/fixtures/petclinic/openapi.yaml`: tags, path/query/body parameters,
  enum and date types, operationIds that differ from method names, an
  operation without operationId, global security with alternatives,
  operation overrides (`[]`, Basic, OAuth2 client credentials, query apiKey,
  bearer), same- and cross-origin redirects, a slow endpoint.
- `sdk-7.26.0/`, `sdk-7.25.0/`: default typescript-fetch output.
- `sdk-variant-7.26.0/`: `useSingleRequestParameter=false`,
  `withInterfaces`, `supportsES6`, `withoutRuntimeChecks`,
  `importFileExtension=.js`, `fileNaming=kebab-case`,
  `prefixParameterInterfaces`.
- `petclinic-sdk-1.2.0.tgz`: the 7.26.0 SDK built with its own `tsc` and
  `npm pack` (contains `src/` and compiled CommonJS `dist/`).
- `test-integration/helpers/mock-api.ts`: local mock API enforcing the spec's
  security; records every request.
- `test-integration/helpers/auth-server.ts`: local authorization server
  (JWKS, client credentials, introspection) for tests only.

Fixtures are regenerated with the development tool
`npx tsx scripts/dev/generate-sdk.ts --spec … --out … [--props k=v,…]`,
which is not part of the package.

## Verification matrix

| # | Requirement | Tests |
| --- | --- | --- |
| 1 | `serve` works directly with `--spec` and `--sdk` | `serve.ts` "CLI processes", `transports.ts`, `http-auth.ts`, `logging.ts`, `package.ts` (installed CLI) |
| 2 | stdio and Streamable HTTP expose `search` and `execute` | `transports.ts`, `serve.ts` |
| 3 | preparation once per process, reused by every session/call | `serve.ts` "should prepare once and reuse…" (one `prepare.*`/`executor.verified`/`tools.registered`, unchanged bundle, three sessions) |
| 4 | search describes the callable SDK methods | `serve.ts` "index every method accurately", `execute.ts` "search and binding agreement", `test/search/*`, `test/prepare/*` |
| 5 | execute calls the real SDK against a local mock API | `execute.ts` "real SDK against the mock API", `serve.ts`, `dev-generate.ts` |
| 6 | MCP and upstream auth, per-operation authorization, isolation, audit | `http-auth.ts`, `upstream-auth.ts`, `execute.ts` "limits, isolation and denied capabilities", `logging.ts`, `test/auth/*`, `test/upstream/*` |
| 7 | actionable errors: missing dependencies, incompatible SDKs, invalid inputs | `serve.ts` "actionable errors" and CLI failure test, cmdt `commands.yml`, `test/prepare/*` |
| 8 | the supplied SDK is unchanged | `serve.ts` "should never modify or add files…" (source directory and compiled CommonJS package), missing-dependency test (no `node_modules` created), `dev-generate.ts`, `test/prepare/sdk-input.ts` |
| 9 | workspaces removed on shutdown and start-up failure | `serve.ts` (in-process close, failure in a late stage, SIGTERM while serving and while starting, stdio disconnect, CLI failure, stale sweep), `test/prepare/workspace.ts` |
| 10 | no build artifacts or build command needed | every test serves straight from fixtures; `serve.ts` checks no manifest/artifact files; `test/cli.ts` |
| 11 | preparation does not corrupt stdio | `serve.ts` stdio test (requests queued during preparation, debug + pretty logs, every stdout line is JSON-RPC), `logging.ts` |
| 12 | removed workflow absent from help and documentation | `test/cli.ts` (only `serve`, no build options), cmdt `commands.yml` (`unknown command 'build'`), `package.ts` (installed `--help`) |
| A | stdio credentials without stdout contamination | `logging.ts` |
| A | HTTP rejects missing/invalid/expired/mis-targeted credentials | `http-auth.ts` |
| A | each upstream mechanism; OAuth caching/renewal | `upstream-auth.ts`, `test/upstream/*` |
| A | agent cannot obtain credentials; none in the workspace | `upstream-auth.ts`, `execute.ts`, `serve.ts` "keep secrets out of the workspace" |
| L | categories separable; audit unaffected by level; redaction; correlation; audit failure policy | `logging.ts`, `test/logging/*` |
