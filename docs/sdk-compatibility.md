# SDK compatibility

oag-mcp supports **only** SDKs produced by the OpenAPI Generator
**typescript-fetch** target. Other OpenAPI Generator targets (typescript-axios,
typescript-node, typescript-angular, typescript, …) and hand-written TypeScript
SDKs are rejected with `SDK_GENERATOR_UNSUPPORTED` or
`SDK_LAYOUT_UNSUPPORTED`.

## Generator versions

| Version | Status |
| --- | --- |
| 7.26.0 | Tested, default for `--generate-sdk` |
| 7.25.0 | Tested |
| anything else | Rejected; `--allow-untested-oag-version` proceeds at your own risk and records `oagVersionTested: false` in the manifest |

The version is read from `.openapi-generator/VERSION`. If that file was
removed, declare it with `--sdk-oag-version <version>`.
`--oag-version` must be an exact version such as `7.26.0`; `latest` is
refused.

## Generator options

Tested (accepted by `--oag-options`, detected for existing SDKs):

| Option | Notes |
| --- | --- |
| `npmName`, `npmVersion` | `--generate-sdk` sets these by default so the SDK is a full npm package |
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
verified to resolve inside the private work directory.

### Generated (`--generate-sdk`)

```bash
oag-mcp build --spec openapi.yaml --generate-sdk \
  [--oag-version 7.26.0] [--oag-backend java|docker] [--oag-jar ./openapi-generator-cli-7.26.0.jar] \
  [--oag-options withInterfaces=true,useSingleRequestParameter=false] --out ./server
```

- **java** (default): needs Java 11+. The JAR is taken from `--oag-jar`,
  `OAG_MCP_OAG_JAR`, the cache (`~/.cache/oag-mcp/openapi-generator/<v>/`,
  overridable with `OAG_MCP_CACHE_DIR`), or downloaded once from Maven
  Central and verified against its published SHA-1. The JAR's reported
  version must match `--oag-version`.
- **docker**: needs a running Docker daemon; uses
  `openapitools/openapi-generator-cli:v<version>` with `--network none`,
  mounting the spec directory read-only. Spec `$ref`s must stay within that
  directory.

The generated package is kept in the artifact (`sdk-package/`) so the same SDK
can be used by ordinary applications:

```ts
import { Configuration, PetsApi } from "./server/sdk-package/src/index";
const api = new PetsApi(new Configuration({ basePath: "https://api.example.com/v1", apiKey: process.env.API_KEY }));
```

## Build requirements and dependencies

typescript-fetch SDKs have no runtime dependencies; the build needs no network
access for them. If an SDK's `package.json` declares `dependencies` that are
not present in its `node_modules`, oag-mcp runs
`npm install --omit=dev --ignore-scripts` **in its private copy** — this
needs network access unless the packages are in your npm cache or a local
registry. Use `--no-install` to forbid it (the build then fails with
`SDK_DEPENDENCIES_MISSING`). Dependencies are bundled into
`sdk/sdk.bundle.js`; they must not require Node.js built-ins, filesystem or
network access at import time.

## How methods are mapped

oag-mcp never assumes `operationId` equals the generated method name
(`list-pet-visits` becomes `listPetVisits`; operations without an
operationId become e.g. `healthGet`). For every public method of every class
extending `BaseAPI`, the HTTP method and path template are read from the
generated `<method>RequestOpts` (7.x) or `<method>Raw` (older output) and
matched to the spec by `METHOD + path`. Build errors:

| Code | Meaning |
| --- | --- |
| `SDK_BINDING_AMBIGUOUS` | a method's HTTP binding could not be determined (modified SDK?) |
| `SDK_SPEC_MISMATCH` | a method matches no operation, or several |
| `SDK_NO_METHODS` | nothing could be bound |

Spec operations without an SDK method (e.g. excluded via
`.openapi-generator-ignore`) are reported as warnings and listed in the
manifest's `unmappedOperations`.

## Dates

typescript-fetch converts `format: date`/`date-time` to `Date` objects. The
sandbox runs with `TZ=UTC`, so `format: date` values round-trip as UTC
midnight (`"2026-03-15T00:00:00.000Z"` in results) regardless of the
server's time zone.
