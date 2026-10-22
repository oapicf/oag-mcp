# Testing and verification

```bash
npm install                 # also builds dist/ (prepare)
npm run typecheck && npm run lint && npm run style
npm test                    # unit tests (test/**/*.ts)
npm run test:integration    # integration tests (test-integration/**/*.ts)
npm run coverage
make ci                     # Suntory/Bob pipeline (needs bob, yq, mdl)
```

No account, paid service or external network is needed by the tests except:
`npm ping`/`npm install` for the packaging test, and Java + a cached generator
JAR (or Maven Central) / Docker for the generation tests. Tests whose
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
  `npm pack` (contains `src/` and compiled `dist/`).
- `test-integration/helpers/mock-api.ts`: local mock API enforcing the spec's
  security; records every request.
- `test-integration/helpers/auth-server.ts`: local authorization server
  (JWKS, client credentials, introspection) for tests only.

## Verification matrix

| # | Requirement | Tests |
| --- | --- | --- |
| 1 | SDK generation/preparation, accurate indexing | `test-integration/build.ts`, `test/build/*` |
| 2 | search returns methods available through `sdk` | `execute.ts` "search and binding agreement", `test/search/*` |
| 3 | execute calls the real SDK against the mock API | `execute.ts` "real SDK against the mock API" |
| 4 | multi-call workflow → compact result | `execute.ts` multi-call test |
| 5 | type and API errors are useful | `execute.ts` "feedback" |
| 6 | timeouts, output limits, isolation, denied capabilities | `execute.ts` "limits, isolation and denied capabilities" |
| 7 | both transports | `transports.ts` |
| 8 | artifact runs without original SDK/spec | `build.ts` "artifact independence" |
| 9 | directory and packaged inputs | `build.ts`, `test/build/sdk-input.ts` |
| 10 | packaged CLI install and launch | `package.ts`, cmdt `commands.yml` |
| A | stdio credentials without stdout contamination | `logging.ts` |
| A | HTTP rejects missing/invalid/expired/mis-targeted credentials | `http-auth.ts` |
| A | each upstream mechanism; OAuth caching/renewal | `upstream-auth.ts`, `test/upstream/*` |
| A | per-operation permissions; concurrent caller isolation; no MCP token forwarding | `http-auth.ts` |
| A | agent cannot obtain credentials | `upstream-auth.ts`, `execute.ts` |
| L | categories separable; audit unaffected by level; per-operation audit; redaction; correlation; stdout purity; audit failure policy | `logging.ts`, `test/logging/*` |
