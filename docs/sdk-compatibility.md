# SDK compatibility

oag-mcp supports **only** SDKs produced by the OpenAPI Generator
**typescript-fetch** target. Other OpenAPI Generator targets (typescript-axios,
typescript-node, typescript-angular, typescript, …) and hand-written TypeScript
SDKs are rejected with `SDK_GENERATOR_UNSUPPORTED` or
`SDK_LAYOUT_UNSUPPORTED`.

## Generator versions

| Version | Status |
| --- | --- |
| 7.26.0 | Tested |
| anything else | Rejected (`SDK_OAG_VERSION_UNSUPPORTED`); `--allow-untested-oag-version` proceeds at your own risk and logs `oagVersionTested: false` |

The version is read from `.openapi-generator/VERSION`. If that file was
removed, declare it with `--sdk-oag-version <version>`.

## Generating an SDK

Use OpenAPI Generator's official Docker image, pinned to an exact version:

```bash
docker run --rm -v "$PWD":/local openapitools/openapi-generator-cli:v7.26.0 \
  generate \
  --input-spec /local/openapi.yaml \
  --generator-name typescript-fetch \
  --output /local/generated-sdk
```

Generator options go in `--additional-properties` (e.g.
`--additional-properties=npmName=petstore-sdk,npmVersion=1.0.0`, recommended
so the SDK is a complete npm package). The `gen-sdk` target in
[`Makefile-extras`](../Makefile-extras) is an example of this command in a
Makefile (`make -f Makefile-extras gen-sdk SPEC=path/to/openapi.yaml`,
output in `stage/generated-sdk/`). Docker is only needed for this step, not
to run oag-mcp.

## Generator options

Tested (detected from the SDK sources at start-up; pass them with
`--additional-properties` when generating):

| Option | Notes |
| --- | --- |
| `npmName`, `npmVersion` | recommended: the SDK is then a complete npm package (`src/`, `package.json`) |
| `supportsES6` | |
| `withInterfaces` | `*ApiInterface` declarations are ignored; classes are bound |
| `useSingleRequestParameter` | `true` (default) → `method({ ... })`; `false` → positional `method(a, b)`; search shows the exact signature |
| `prefixParameterInterfaces` | |
| `withoutRuntimeChecks` | |
| `importFileExtension` | `''` or `.js` |
| `fileNaming` | `PascalCase`, `camelCase`, `kebab-case` |
| `modelPropertyNaming`, `paramNaming`, `enumPropertyNaming`, `sortParamsByRequiredFlag`, `sortModelPropertiesByRequiredFlag`, `ensureUniqueParams` | |

Rejected:

| Option | Why |
| --- | --- |
| `sagasAndRecords` | redux-saga/immutable code; not an SDK the sandbox can use |
| `stringEnums=true` | TypeScript `enum`s cannot be referenced from agent code (it has no imports); the default string-literal unions work |
| `dateLibrary=temporal` | experimental upstream |
| others | `SDK_OPTION_UNTESTED` |

## Accepted inputs

### Package directory (`--sdk ./dir`)

Either layout is accepted (`--sdk-layout auto` prefers sources):

```text
source layout                         compiled layout
my-sdk/                               my-sdk/
├── package.json        (optional)    ├── package.json  (main/module/types)
├── .openapi-generator/VERSION        ├── .openapi-generator/VERSION
└── src/                              └── dist/
    ├── index.ts                          ├── index.js / index.d.ts
    ├── runtime.ts                        ├── runtime.js / runtime.d.ts
    ├── apis/*Api.ts                      ├── apis/*.js / *.d.ts
    └── models/*.ts                       └── esm/…   (preferred entry if present)
```

SDKs generated without `npmName` (files at the root: `index.ts`,
`runtime.ts`, `apis/`) are accepted with a warning.

### Package archive (`--sdk ./sdk-1.0.0.tgz`)

An `npm pack` archive. Before extraction every entry is checked: absolute
paths, `..` segments, symbolic/hard links, devices and FIFOs are rejected,
the archive must have one top-level directory, and entry count (20 000) and
uncompressed size (256 MiB) are bounded. After extraction every path is
verified to resolve inside the private workspace, which is removed when the
server stops.

Archives produced by `npm pack` normally contain the compiled `dist/` (and,
for typescript-fetch packages, `src/`); use `--sdk-layout compiled` to serve
the compiled JavaScript, or the default to prefer sources.

### Source versus compiled packages

| | Source layout | Compiled layout |
| --- | --- | --- |
| What is read | `src/**/*.ts` | `dist/**/*.js` (or `dist/esm/`) and `dist/**/*.d.ts` |
| Declarations | emitted by oag-mcp's pinned TypeScript into the workspace | copied into the workspace |
| Execution bundle | esbuild compiles and bundles the sources | esbuild bundles the compiled JavaScript (CommonJS gets an ESM shim) |
| Your build tooling | not needed | not run — the package must already contain `dist/` |

oag-mcp never runs the SDK's own `build`/`prepare` scripts, `tsc` from the
SDK, or any package lifecycle script. A package that ships neither sources
nor compiled output is rejected with `SDK_LAYOUT_UNSUPPORTED`.

## Runtime dependencies

typescript-fetch SDKs have no runtime dependencies, so nothing else is
needed. If an SDK's `package.json` declares `dependencies`, each must
already be installed where Node.js would find it — the SDK's
`node_modules` or a parent directory's (workspaces and monorepos work).
Otherwise start-up stops with `SDK_DEPENDENCIES_MISSING`, naming the
packages; install them yourself, e.g.

```bash
cd ./generated-sdk && npm install --omit=dev --ignore-scripts
```

For an archive, extract it, install dependencies in the extracted
`package/` directory, and pass that directory to `--sdk`. oag-mcp never
installs packages and never writes to the SDK; dependencies are bundled into
the workspace's `sdk/sdk.bundle.js` and must not need Node.js built-ins,
filesystem or network access at import time.

## How methods are mapped

oag-mcp never assumes `operationId` equals the generated method name
(`list-pet-visits` becomes `listPetVisits`; operations without an
operationId become e.g. `healthGet`). For every public method of every class
extending `BaseAPI`, the HTTP method and path template are read from the
generated `<method>RequestOpts` (7.x) or `<method>Raw` (older output) and
matched to the spec by `METHOD + path`. Start-up errors:

| Code | Meaning |
| --- | --- |
| `SDK_BINDING_AMBIGUOUS` | a method's HTTP binding could not be determined (modified SDK?) |
| `SDK_SPEC_MISMATCH` | a method matches no operation, or several |
| `SDK_NO_METHODS` | nothing could be bound |

Spec operations without an SDK method (e.g. excluded via
`.openapi-generator-ignore`) are logged as `prepare.warning` records and are
not offered by `search`.

Bindings are fixed for the lifetime of the process. After regenerating the
SDK or editing the spec, restart oag-mcp.

## Dates

typescript-fetch converts `format: date`/`date-time` to `Date` objects. The
sandbox runs with `TZ=UTC`, so `format: date` values round-trip as UTC
midnight (`"2026-03-15T00:00:00.000Z"` in results) regardless of the
server's time zone.
