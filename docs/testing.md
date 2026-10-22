# Testing

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

## What is verified where

| Area | Tests |
| --- | --- |
| `serve` from `--spec`/`--sdk`, from the source tree and from the installed package | `serve.ts` "CLI processes", `transports.ts`, `http-auth.ts`, `logging.ts`, `package.ts` |
| both transports expose `search` and `execute` | `transports.ts`, `serve.ts` |
| preparation runs once per process and is reused by every session and call | `serve.ts` "should prepare once and reuse…" |
| search describes the callable SDK methods accurately | `serve.ts` "index every method accurately", `execute.ts` "search and binding agreement", `test/search/*`, `test/prepare/*` |
| execute calls the real SDK against a local mock API | `execute.ts`, `serve.ts`, `dev-generate.ts` |
| supported inputs: source and compiled layouts, archives, 7.25.0/7.26.0, option variants | `serve.ts` "supported SDK inputs", `test/prepare/*` |
| actionable errors: invalid inputs, missing dependencies, incompatible SDKs, spec/SDK mismatch | `serve.ts` "actionable errors" and CLI failure test, cmdt `commands.yml`, `test/prepare/*` |
| the supplied SDK is never modified | `serve.ts` "should never modify or add files…", the missing-dependency test, `dev-generate.ts`, `test/prepare/sdk-input.ts` |
| the workspace is removed on shutdown, start-up failure, signals during start-up, stdio disconnect, and after a killed process | `serve.ts`, `test/prepare/workspace.ts` |
| stdio stdout carries only MCP traffic, including during preparation | `serve.ts` stdio test, `logging.ts` |
| CLI surface and help | `test/cli.ts`, cmdt `commands.yml` |
| MCP authentication on HTTP (missing/invalid/expired/mis-targeted credentials), stdio principals | `http-auth.ts`, `logging.ts` |
| upstream authentication for each mechanism; OAuth caching and renewal | `upstream-auth.ts`, `test/upstream/*` |
| per-operation authorization, concurrent caller isolation, no MCP token forwarding | `http-auth.ts`, `test/auth/*` |
| sandbox limits, isolation and denied capabilities | `execute.ts` "limits, isolation and denied capabilities" |
| agent code cannot obtain credentials; none in the workspace | `upstream-auth.ts`, `execute.ts`, `serve.ts` "keep secrets out of the workspace" |
| logging: separable categories, audit independent of level, redaction, correlation, audit failure policy | `logging.ts`, `test/logging/*` |
