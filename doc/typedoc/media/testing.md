# Testing

OAG-MCP is tested at four levels, each run by a `make` target, and together
by `make ci`:

- **Lint checks** keep the code type-safe, formatted, and simple enough to
  review.
- **Unit tests** check each module of `lib/` on its own, with fakes for its
  neighbours, and cover every line of it.
- **Integration tests** run the real `oag-mcp` command against a real
  OpenAPI document, real generated SDKs, a local mock API and a local
  authorization server, through both MCP transports, with agent code running
  in the real Deno sandbox.
- **Extra checks** confirm that OAG-MCP accepts the SDKs it says it does, and
  that its security audit records are valid OCSF events.

The security features in particular are tested from the outside: that the
sandbox denies what it should, that forged messages from agent code are
refused, that credentials never reach the agent, the workspace or the logs,
and that a caller cannot call what its rules deny. The
[integration tests table](#what-the-integration-tests-verify) lists where.

No account, paid service, Docker or external network is needed, apart from
the npm registry for the packaging test and the OCSF check's downloads. A
test whose prerequisites are missing is skipped and prints
`[blocked: <reason>]`, rather than passing silently.

```bash
make deps                   # npm install, which also builds dist/
make ci                     # everything below, in order (needs yq)
```

`make ci` runs `clean build typecheck style lint test coverage complexity doc
package reinstall test-integration`.

## Lint checks

```bash
make typecheck              # type-check sources and tests
make style                  # format with Prettier
make lint                   # ESLint, then the OCSF conformance check
make complexity             # complexity report in stage/gh-pages/complexity/
```

- **Type checking.** `tsc --noEmit` checks `lib/`, `test/` and
  `test-integration/` against `tsconfig.json`. The tests run through tsx, which does not
  type-check, so `make test`, `make test-integration` and `make coverage` each
  run `make typecheck` first.
- **Formatting.** Prettier formats `lib`, `test`, `test-integration`,
  `assets`, `bin` and `eslint.config.js`. `make style` rewrites the files;
  `prettier --check` with the same paths only reports.
- **ESLint**, with typescript-eslint, checks the whole repository. It fails
  for any function in `lib/` with a cyclomatic complexity above 10, the same
  limit (`COMPLEXITY_MAX`) that `make complexity` reports against.
- **OCSF conformance** runs at the end of `make lint`, through Olympia's
  `x-post-lint` hook in `Makefile-extras`. See
  [OCSF conformance](#ocsf-conformance).

## Unit testing

```bash
make test                   # test/**/*.ts, report in stage/gh-pages/test/
```

The unit tests in `test/` mirror `lib/`: one folder per module group
(`executor`, `logging`, `prepare`, `search`, `server`, `upstream`, `util`)
and one file per module. They run with Mocha through tsx, configured in
`package.json` (`"mocha"`), with
[referee](https://github.com/busterjs/referee) assertions, Sinon fakes and
esmock for replacing a module's imports. Shared helpers are in
`test/helpers/`: quiet logs and a fake `fetch`, a reader for captured log
records, fixture paths, and a prepared SDK and executor that need neither a
workspace nor Deno.

They need no network, Deno or running server, so they finish in well under a
minute. Code that depends on the outside world is tested against fakes here
and for real in the integration tests.

The unit tests also check the documentation: every `oag-mcp serve` command
in the README, `docs/` and `examples/` must pass both `--spec` and `--sdk`.

## Coverage checks

```bash
make coverage               # report in stage/gh-pages/coverage/c8/
```

c8 runs the unit tests and measures coverage of `lib/`, printing a summary
and writing an HTML and lcov report. The unit tests cover every line of
`lib/`; keep it that way when adding code. Branch and function coverage are
reported too, but are not held at 100%.

Coverage is measured on the unit tests only. The integration tests exercise
the same code through the real command, but are not counted.

## Integration testing

```bash
make test-integration       # test-integration/**/*.ts, report in stage/gh-pages/test-integration/
```

The integration tests in `test-integration/` start the real `oag-mcp`
command, from the source tree and, in the packaging test, from a globally
installed package, and talk to it as an MCP client would. Around it, the
helpers in `test-integration/helpers/` provide:

- **a mock API** (`mock-api.ts`), the Pet Clinic API on a local port. It
  enforces the security the OpenAPI document declares, and records every
  request, so a test can check exactly what reached the API and what did
  not;
- **an authorization server** (`auth-server.ts`) for tests only. It issues
  upstream client credentials tokens, which tests can revoke; mints MCP
  OAuth tokens, including expired, mis-targeted and wrongly signed ones, and
  publishes the keys to check them; and answers token introspection;
- **shared set-up** (`env.ts`): fixture paths, test credentials, temporary
  folders, and helpers to start a server and connect a client.

Each test file covers one area, and runs in seconds to a minute; the whole
suite takes a few minutes, most of it starting servers and Deno sandboxes.
Every test cleans up its servers, processes and temporary folders.

### What the integration tests verify

| Area | Tests |
| --- | --- |
| `serve` from `--spec` and `--sdk`, from the source tree and from the installed package | `serve.ts` "CLI processes", `transports.ts`, `http-auth.ts`, `logging.ts`, `package.ts` |
| Both transports expose `search` and `execute` | `transports.ts`, `serve.ts` |
| Preparation runs once per process and is reused by every session and call | `serve.ts` "should prepare once and reuse…" |
| `search` describes the callable SDK methods accurately | `serve.ts` "index every method accurately", `execute.ts` "search and binding agreement", unit tests in `test/search/` and `test/prepare/` |
| `execute` calls the real SDK against the mock API | `execute.ts`, `serve.ts` |
| Supported inputs: source and compiled layouts, archives, the supported generator version, option variants | `serve.ts` "supported SDK inputs", unit tests in `test/prepare/` |
| Actionable errors: invalid inputs, missing dependencies, incompatible SDKs, a spec that does not match the SDK | `serve.ts` "actionable errors" and the CLI failure test, `cli.ts`, unit tests in `test/prepare/` |
| The supplied SDK is never modified | `serve.ts` "should never modify or add files…", the missing-dependency test, `test/prepare/sdk-input.ts` |
| The workspace is removed on shutdown, start-up failure, signals during start-up, stdio disconnect, and after a killed process | `serve.ts`, `test/prepare/workspace.ts` |
| stdio stdout carries only MCP traffic, including during preparation | `serve.ts` stdio test, `logging.ts` |
| The CLI's commands, flags and help | `cli.ts`, `test/cli.ts` |
| MCP authentication over HTTP (missing, invalid, expired and mis-targeted credentials), and stdio principals | `http-auth.ts`, `logging.ts` |
| Upstream authentication for each scheme; OAuth2 token caching and renewal | `upstream-auth.ts`, `test/upstream/` |
| Per-operation authorisation, isolation of concurrent callers, MCP tokens never forwarded | `http-auth.ts`, `test/server/` |
| Sandbox limits, isolation and denied capabilities | `execute.ts` "limits, isolation and denied capabilities" |
| Forged bridge messages from agent code are refused or re-checked: denied operations, mismatched method, path or origin, unknown bindings, credentials supplied by the code | `execute.ts` "forged bridge messages from agent code" |
| Agent code cannot obtain credentials, and the workspace holds none | `upstream-auth.ts`, `execute.ts`, `serve.ts` "keep secrets out of the workspace" |
| Logging: separate kinds, audit independent of level, redaction, correlation, audit failure policy | `logging.ts`, `test/logging/`, `test/util/redact.ts` |

## Extra checks

These go beyond what `make test` and `make test-integration` cover. Both
targets are in `Makefile-extras`.

### SDK compatibility

OAG-MCP serves only SDKs from the OpenAPI Generator versions it has been
tested with (`SUPPORTED_OAG_VERSIONS` in `lib/util/version.ts`, currently
7.26.0), with the generator options it supports; see
[SDK compatibility](sdk-compatibility.md). The tests hold it to that:

- the integration tests serve the [fixture SDKs](#fixtures) in each layout
  and form: sources and compiled packages, a directory and an archive, the
  default options and a variant with most options changed;
- they check that SDKs from other generators, other versions and unsupported
  options are refused with a clear error, and that the spec and the SDK must
  match;
- the unit tests in `test/prepare/` cover each compatibility rule on its own.

To test a new generator version, regenerate the fixtures with it and run the
whole suite. Set `OPENAPI_GENERATOR_VERSION` in `Makefile-extras`, pull the
generator's Docker image with `make -f Makefile-extras x-post-deps`, then run
`gen-sdk`:

```bash
make -f Makefile-extras gen-sdk SPEC=test/fixtures/petclinic/openapi.yaml SDK_NAME=petclinic-sdk SDK_VERSION=1.2.0
```

It writes the SDK to `stage/generated-sdk/` and the packed archive to
`stage/petclinic-sdk-1.2.0.tgz`, the equivalents of `sdk-7.26.0/` and
`petclinic-sdk-1.2.0.tgz`. For the variant fixture, add its
`--additional-properties`. Once the suite passes, add the version to
`SUPPORTED_OAG_VERSIONS`. This needs Docker; nothing else in the tests does.

### OCSF conformance

```bash
make -f Makefile-extras test-ocsf
```

This checks that OAG-MCP's security audit records are valid
[OCSF](https://ocsf.io/) events, at the OCSF version in
`lib/logging/ocsf.ts`. It:

1. downloads the OCSF schema at that version, and compiles it with
   [ocsf-lib](https://pypi.org/project/ocsf-lib/) in a Python virtual
   environment under `stage/ocsf/` (through
   `test-integration/helpers/compile-ocsf.py`, which lets ocsf-lib 0.10.4
   run on Python 3.14);
2. writes an audit record for every audit event, plus the records of real
   executions against the mock API (`test-integration/helpers/ocsf-events.ts`);
3. validates each record (`test-integration/helpers/validate-ocsf.py`): class,
   activity and type ids, attribute names, types and enum values, required
   attributes, constraints and profiles.

`make lint`, and so `make ci`, runs it through the `x-post-lint` hook. It
needs git, python3 with venv, and network access to GitHub and PyPI. A new
audit event without a case in `ocsf-events.ts` fails it.

## Fixtures

The fixtures in `test/fixtures/petclinic/` describe one API, the Pet Clinic,
in every form OAG-MCP accepts:

| Fixture | What it is |
| --- | --- |
| `openapi.yaml` | The OpenAPI document. It covers tags; path, query and body parameters; enum and date types; `operationId`s that differ from method names, and an operation without one; global security with alternatives, and operations that override it (`[]`, basic, OAuth2 client credentials, an API key in the query, bearer); same-origin and cross-origin redirects; and a slow endpoint. |
| `sdk-7.26.0/` | The typescript-fetch SDK generated from it by OpenAPI Generator 7.26.0, with the default options. |
| `sdk-variant-7.26.0/` | The same, with options changed: `useSingleRequestParameter=false`, `withInterfaces`, `supportsES6`, `withoutRuntimeChecks`, `importFileExtension=.js`, `fileNaming=kebab-case` and `prefixParameterInterfaces`. |
| `petclinic-sdk-1.2.0.tgz` | The 7.26.0 SDK built with its own `tsc` and packed with `npm pack`, containing both `src/` and compiled CommonJS `dist/`. |

The SDK fixtures are generated output committed to the repository, so the
tests never run the generator. To regenerate them, see
[SDK compatibility](#sdk-compatibility).

The mock API and the authorization server in `test-integration/helpers/`
serve the same API and its credentials; see
[Integration testing](#integration-testing).
