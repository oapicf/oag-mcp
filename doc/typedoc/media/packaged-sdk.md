# Packaged SDK

The simplest way to give OAG-MCP its SDK is the folder OpenAPI Generator
wrote. For a deployment, a versioned package is better: one `.tgz` file that
is built once, stored with your other releases, and identified by its hash in
OAG-MCP's logs. This recipe serves the SDK from an `npm pack` archive, and
covers SDKs whose layout or generator version needs declaring.

OAG-MCP reads the SDK, folder or archive, once at start-up and never changes
it. It extracts an archive into its own temporary folder, and does not run
`npm install` or any of the package's scripts.

## Making the archive

In the SDK folder that OpenAPI Generator wrote, with `npmName` and
`npmVersion` set when generating (see
[SDK compatibility](../sdk-compatibility.md#generating-an-sdk)):

```bash
cd generated-sdk
npm install      # also builds dist/ through the SDK's prepare script
npm pack         # writes petclinic-sdk-1.2.0.tgz
```

The archive contains the TypeScript sources (`src/`), the compiled package
(`dist/`) and `.openapi-generator/VERSION`. If the SDK is published to a
package registry, `npm pack petclinic-sdk@1.2.0` downloads the same archive
from it, without installing anything.

## Running it

Pass the archive to `--sdk` as you would the folder:

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./petclinic-sdk-1.2.0.tgz \
  --config ./oag-mcp.yaml
```

A configuration that serves the Pet Clinic archive read-only is in
[`examples/oag-mcp-packaged-sdk.config.yaml`](../../examples/oag-mcp-packaged-sdk.config.yaml).

An archive is served exactly like the folder it came from: the same methods,
the same results. Restart OAG-MCP to change to another archive.

### Sources or compiled package

An SDK can come in two layouts, and OAG-MCP can use either:

| `--sdk-layout` | Uses |
| --- | --- |
| `auto` (default) | The sources when the SDK has them, otherwise the compiled package |
| `source` | `src/*.ts` |
| `compiled` | `dist/*.js` with its `.d.ts` declarations |

`auto` is right for most SDKs. Use `compiled` for a package that should be
served exactly as it was built and published, or `source` to make sure a
package without sources is refused rather than served from `dist/`:

```text
Error [SDK_LAYOUT_UNSUPPORTED]: No typescript-fetch sources (src/index.ts, src/runtime.ts) found in /srv/sdk
Hint: Use --sdk-layout compiled for packages that ship only dist/.
```

### Generator version

OAG-MCP is tested with particular OpenAPI Generator versions, and reads which
one made the SDK from `.openapi-generator/VERSION`. Three things can go wrong:

The file is missing, for example because it was left out of the package:

```text
Error [SDK_OAG_VERSION_UNKNOWN]: Cannot determine the OpenAPI Generator version of the SDK in /srv/sdk
Hint: The generator writes .openapi-generator/VERSION. If it was removed, pass --sdk-oag-version <version> to declare it.
```

Declare the version the SDK was generated with:

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./sdk --sdk-oag-version 7.26.0
```

A declared version must agree with the file when the file exists:

```text
Error [SDK_OAG_VERSION_CONFLICT]: --sdk-oag-version 7.25.0 conflicts with .openapi-generator/VERSION 7.26.0
```

The version is not one OAG-MCP has been tested with:

```text
Error [SDK_OAG_VERSION_UNSUPPORTED]: OpenAPI Generator 7.27.0 is not in the tested set (7.26.0)
Hint: Regenerate the SDK with a tested OpenAPI Generator version (7.26.0), or pass --allow-untested-oag-version to proceed at your own risk.
```

Regenerating with a tested version is the safe fix. To try an untested one,
pass `--allow-untested-oag-version`: OAG-MCP still runs every compatibility
check, and starts if they pass.

## What the logs show

The examples below come from the Pet Clinic SDK. This `jq` command prints the
preparation records with their details:

```bash
jq -c 'select(.EventName // "" | startswith("prepare.")) | {event: .EventName, attributes: .Attributes}' oag-mcp.log
```

`prepare.sdk.resolved` says what `--sdk` pointed at, a `directory` or an
`archive`, and `prepare.compat.checked` which layout was chosen and the
generator version:

```json
{
  "EventName": "prepare.compat.checked",
  "Attributes": {
    "oag_mcp.layout": "source",
    "oag_mcp.oag_version": "7.26.0",
    "oag_mcp.oag_version_tested": true,
    "oag_mcp.api_files": 4,
    "oag_mcp.outcome": "success"
  }
}
```

`prepare.sdk.prepared` closes the preparation with SHA-256 hashes of the
OpenAPI document and the SDK. For an archive, `oag_mcp.sdk_sha256` is the
hash of the `.tgz` file itself, so `sha256sum petclinic-sdk-1.2.0.tgz` shows
exactly which build a server is running:

```json
{
  "EventName": "prepare.sdk.prepared",
  "Attributes": {
    "oag_mcp.prepare.id": "74217859-b25e-4548-8851-c2322e49373e",
    "oag_mcp.methods": 11,
    "oag_mcp.oag_version": "7.26.0",
    "oag_mcp.sdk_layout": "source",
    "oag_mcp.sdk_kind": "archive",
    "oag_mcp.spec_sha256": "531a654a93d03daee73c2f6710db885d5f6ff19691699529e7b7bd946368f627",
    "oag_mcp.sdk_sha256": "4829a1cafe691af46dafdde74179dab1abe4cacea7beeba72ecf7b23972c0e91",
    "oag_mcp.duration_ms": 2913
  }
}
```

For a folder, `oag_mcp.sdk_sha256` is a hash of its files. With
`--sdk-layout compiled`, `oag_mcp.layout` and `oag_mcp.sdk_layout` say
`compiled`.

When an untested generator version is allowed, `prepare.compat.checked` has
`oag_mcp.oag_version_tested: false`, followed by a `prepare.warning`:

```json
{
  "SeverityText": "WARN",
  "EventName": "prepare.warning",
  "Attributes": {
    "oag_mcp.warning": "OpenAPI Generator 7.27.0 is untested; proceeding because --allow-untested-oag-version was given."
  }
}
```

[SDK compatibility](../sdk-compatibility.md) covers the generator options
OAG-MCP accepts and the checks it runs, and the
[CLI reference](../reference/cli.md) every flag.
