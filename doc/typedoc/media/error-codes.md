# Error codes reference

When `oag-mcp serve` cannot start, it exits with status 1 and prints one error
to stderr: a stable error code, a message saying what is wrong, and usually a
hint saying what to do.

```text
Error [SDK_OAG_VERSION_UNSUPPORTED]: OpenAPI Generator 7.27.0 is not in the tested set (7.26.0)
Hint: Regenerate the SDK with a tested OpenAPI Generator version (7.26.0), or pass --allow-untested-oag-version to proceed at your own risk.
```

The code is stable, so scripts and deployment tools can branch on it; the
message and hint are for people and may change between versions. OAG-MCP
never starts a partially working server: any of these errors stops it before
it accepts an MCP request.

Once logging has started, the same code is recorded as `error.type` in the
operational records `cli.command.failed` and, during preparation,
`prepare.stage.failed` with the stage that failed. Errors about security
settings are also recorded as `security.config_invalid` or
`credential.config_invalid` audit records. A configuration error happens
before logging starts, so it appears only on stderr.

These codes are for start-up. Errors returned to the agent by an `execute`
call are [error types](error-types.md), and [Troubleshooting](../troubleshooting.md)
works back from both to their causes.

## Error codes

The **Stage** column links to the step of [How it works](../how-it-works.md)
in which each error can occur.

| Error code | Description | Stage | What to do | Example |
| --- | --- | --- | --- | --- |
| `CLI_ARGS_INVALID` | `--spec` or `--sdk` is missing. The command line is normally checked before this, with a shorter message. | [1](../how-it-works.md#1-read-the-command-line-and-the-configuration) | Pass both. | `--sdk is required` |
| `CONFIG_NOT_FOUND` | The `--config` file cannot be read. | [1](../how-it-works.md#1-read-the-command-line-and-the-configuration) | Check the path and its permissions. | `Cannot read configuration file ./oag-mcp.yaml` |
| `CONFIG_INVALID` | The configuration file is not valid YAML or JSON, or has unknown properties or values out of range. Up to eight problems are listed, each with its property's path. | [1](../how-it-works.md#1-read-the-command-line-and-the-configuration) | Fix each property named; see the [configuration reference](configuration.md). | `Invalid configuration in ./oag-mcp.yaml: upstream: Unrecognized key: "timeoutMS"` |
| `SPEC_NOT_FOUND` | The `--spec` file does not exist. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Check the path. | `OpenAPI document ./openapi.yaml does not exist` |
| `SPEC_INVALID` | The OpenAPI document cannot be parsed or is not valid OpenAPI, or refers to a remote `$ref`, which OAG-MCP does not fetch. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Fix the document, or copy remote references into local files. | `OpenAPI document ./openapi.yaml could not be loaded: …` |
| `SPEC_VERSION_UNSUPPORTED` | The document is not OpenAPI 3.0 or 3.1, for example Swagger 2.0. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Convert it, for example with swagger2openapi. | `OpenAPI version "2.0" is not supported` |
| `SDK_NOT_FOUND` | The `--sdk` path does not exist. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Check the path. | `SDK path ./generated-sdk does not exist` |
| `SDK_INPUT_UNSUPPORTED` | The `--sdk` path is neither a folder nor a `.tgz` archive. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Pass the SDK folder or an `npm pack` archive. | `SDK input ./sdk.zip is neither a directory nor a .tgz package archive` |
| `SDK_ARCHIVE_INVALID` | The archive cannot be read as a gzip-compressed tar file. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Make it with `npm pack`. | `SDK archive ./sdk.tgz could not be read: …` |
| `SDK_ARCHIVE_LAYOUT` | The archive does not hold one top-level folder, as `npm pack` archives do. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Make it with `npm pack`. | `SDK archive must contain a single top-level directory (found: …)` |
| `SDK_ARCHIVE_UNSAFE` | The archive contains links, absolute paths or `..` segments, which could write outside OAG-MCP's folder. | [2](../how-it-works.md#2-read-the-openapi-document-and-the-sdk) | Repack the SDK with `npm pack`, and check where the archive came from. | `SDK archive ./sdk.tgz contains unsafe entries: …` |
| `SDK_GENERATOR_UNSUPPORTED` | The SDK was made by another OpenAPI Generator target, or lacks typescript-fetch's runtime. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Regenerate it with `-g typescript-fetch`. | `The SDK in ./sdk looks like OpenAPI Generator "typescript-axios" output` |
| `SDK_LAYOUT_UNSUPPORTED` | The SDK's files are not where typescript-fetch puts them, the chosen `--sdk-layout` is not present, or there are no API classes. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Check the SDK was fully generated, or choose another `--sdk-layout`. | `No typescript-fetch sources (src/index.ts, src/runtime.ts) found in ./sdk` |
| `SDK_OAG_VERSION_UNKNOWN` | `.openapi-generator/VERSION` is missing, so the generator version is unknown. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Pass `--sdk-oag-version`; see [Packaged SDK](../recipes/packaged-sdk.md). | `Cannot determine the OpenAPI Generator version of the SDK in ./sdk` |
| `SDK_OAG_VERSION_CONFLICT` | `--sdk-oag-version` disagrees with `.openapi-generator/VERSION`. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Remove the flag; the file wins. | `--sdk-oag-version 7.25.0 conflicts with .openapi-generator/VERSION 7.26.0` |
| `SDK_OAG_VERSION_UNSUPPORTED` | The generator version is not one OAG-MCP is tested with. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Regenerate with a tested version, or pass `--allow-untested-oag-version`. | `OpenAPI Generator 7.27.0 is not in the tested set (7.26.0)` |
| `SDK_OPTION_UNSUPPORTED` | The SDK was generated with an option the sandbox cannot use: `sagasAndRecords`, `stringEnums=true` or `dateLibrary=temporal`. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Regenerate without it; see [SDK compatibility](../sdk-compatibility.md#generator-options). | `The SDK was generated with stringEnums=true, which is not supported` |
| `SDK_PACKAGE_INVALID` | The SDK's `package.json` is not valid JSON. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Fix or regenerate it. | `package.json in ./sdk is not valid JSON` |
| `SDK_DEPENDENCIES_MISSING` | Runtime dependencies the SDK declares are not installed. OAG-MCP never installs packages. | [3](../how-it-works.md#3-check-the-sdk-is-compatible) | Run `npm install --omit=dev --ignore-scripts` in the SDK folder. | `SDK runtime dependencies are not installed: …` |
| `SDK_BUNDLE_FAILED` | The SDK could not be bundled for the sandbox, typically because it imports a package that is not installed or a Node.js built-in. | [4](../how-it-works.md#4-prepare-the-sdk-for-the-sandbox) | Install its dependencies; an SDK changed after generation may need regenerating. | `Bundling the SDK failed: …` |
| `SDK_BUNDLE_EXPORTS` | The SDK's index does not export its runtime and API classes, as typescript-fetch's does. | [4](../how-it-works.md#4-prepare-the-sdk-for-the-sandbox) | Check for a modified `index.ts`, or regenerate. | `The SDK bundle does not export: …` |
| `SDK_DECLARATIONS_FAILED` | The SDK's TypeScript declarations could not be produced. | [4](../how-it-works.md#4-prepare-the-sdk-for-the-sandbox) | Check the SDK compiles; regenerate if it was changed. | `Emitting SDK declarations failed: …` |
| `SDK_BINDING_AMBIGUOUS` | The HTTP method and path of some SDK methods could not be read from their generated code. | [5](../how-it-works.md#5-index-the-sdks-methods) | Regenerate the SDK with a supported generator version, unmodified. | `Could not reliably map SDK methods to HTTP operations: …` |
| `SDK_SPEC_MISMATCH` | SDK methods do not match the OpenAPI document's operations: the SDK was generated from another version of the document. | [5](../how-it-works.md#5-index-the-sdks-methods) | Pass the document the SDK was generated from, or regenerate the SDK from this one. | `The SDK does not match the OpenAPI document: …` |
| `SDK_NO_METHODS` | No SDK method matches any operation. | [5](../how-it-works.md#5-index-the-sdks-methods) | Check `--spec` and `--sdk` belong together. | `No SDK methods could be bound to OpenAPI operations` |
| `CONFIG_BASE_URL_REQUIRED` | The OpenAPI document's first server URL is missing or not absolute, and `upstream.baseUrl` is not set. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox) | Set `upstream.baseUrl`. | `No absolute upstream base URL is available (spec servers: /v1)` |
| `UPSTREAM_AUTH_CONFIG_INVALID` | Upstream credentials cannot be set up: a referenced environment variable or secret is missing, the secrets file is readable by others, a scheme name is not in the document, a scheme is unsupported, or a token URL is not HTTPS. Every problem is listed. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox) | Fix each problem listed; see [Upstream credentials](../recipes/upstream-credentials.md). | `Invalid upstreamAuth configuration: bearerAuth: Environment variable API_TOKEN (for bearerAuth.token) is not set` |
| `SECRET_NOT_FOUND` | A secret reference outside `upstreamAuth`, such as a static bearer token or an introspection secret, names an environment variable that is not set or a key not in the secrets file. Inside `upstreamAuth`, the same problem is reported as `UPSTREAM_AUTH_CONFIG_INVALID`. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox), [7](../how-it-works.md#7-open-the-transport) | Set the variable, or add the key to the secrets file. | `Environment variable MCP_TOKEN (for mcpAuth token for team-agent) is not set` |
| `SECRETS_FILE_MISSING` | A `{ secret: … }` reference is used, but `upstreamAuth.secretsFile` is not set or cannot be read. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox), [7](../how-it-works.md#7-open-the-transport) | Set `upstreamAuth.secretsFile` to a readable file. | `Secrets file /srv/oag-mcp/secrets.yaml cannot be read` |
| `SECRETS_FILE_PERMISSIONS` | The secrets file is readable by group or others. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox), [7](../how-it-works.md#7-open-the-transport) | `chmod 600` the file. | `Secrets file /srv/oag-mcp/secrets.yaml is readable by group or others (mode 644)` |
| `SECRETS_FILE_INVALID` | The secrets file is not a mapping of keys to string values. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox), [7](../how-it-works.md#7-open-the-transport) | Make it a flat YAML or JSON map. | `Secrets file /srv/oag-mcp/secrets.yaml must be a mapping of key to string value` |
| `DENO_NOT_FOUND` | No Deno runtime was found for the sandbox. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox) | Reinstall OAG-MCP, install Deno 2.x, or set `OAG_MCP_DENO_PATH` or `execution.denoPath`. | `No Deno runtime was found for the execute tool` |
| `DENO_VERSION_UNSUPPORTED` | The Deno runtime found is not a supported 2.x version. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox) | Install a supported Deno 2.x, or point `OAG_MCP_DENO_PATH` at one. | `Deno 1.46.3 at /usr/local/bin/deno is outside the supported range …` |
| `EXECUTOR_VERIFY_FAILED` | The prepared SDK failed to load in the sandbox, typically because it uses Node.js built-ins, files or the network when it is imported. | [6](../how-it-works.md#6-set-up-credentials-policy-and-the-sandbox) | Check the SDK is unmodified typescript-fetch output. | `The SDK bundle failed to load in Deno: …` |
| `MCP_AUTH_REQUIRED` | Streamable HTTP on a non-loopback address without MCP authentication. | [7](../how-it-works.md#7-open-the-transport) | Set `mcpAuth.mode` to `static-bearer` or `oauth`, or listen on `127.0.0.1`; see [Remote server](../recipes/remote-server.md). | `Refusing to serve unauthenticated MCP on non-loopback address 0.0.0.0` |
| `MCP_AUTH_CONFIG_INVALID` | The `mcpAuth` mode has no settings: `static-bearer` without tokens, or `oauth` without an `oauth` section. | [7](../how-it-works.md#7-open-the-transport) | Add the mode's settings; see [Per-caller permissions](../recipes/per-caller-permissions.md). | `mcpAuth.mode is oauth but mcpAuth.oauth is not configured` |
| `MCP_AUTH_TOKEN_WEAK` | A static bearer token is shorter than 16 characters. | [7](../how-it-works.md#7-open-the-transport) | Generate a long one, for example with `openssl rand -hex 32`. | `Static bearer token for team-agent is shorter than 16 characters` |
| `MCP_AUTH_ISSUER_INSECURE` | The OAuth issuer is plain HTTP on a non-loopback host. | [7](../how-it-works.md#7-open-the-transport) | Use the issuer's HTTPS URL. | `OAuth issuer http://auth.example.com/ must use HTTPS` |
| `MCP_AUTH_ISSUER_MISMATCH` | The authorization server's metadata names a different issuer from `mcpAuth.oauth.issuer`. | [7](../how-it-works.md#7-open-the-transport) | Set `issuer` to exactly the value the server publishes, including any trailing `/`. | `Authorization server metadata at … reports issuer …, expected …` |
| `MCP_AUTH_JWKS_UNKNOWN` | The authorization server's signing keys could not be discovered. | [7](../how-it-works.md#7-open-the-transport) | Set `mcpAuth.oauth.jwksUri`, or configure `introspection`. | `Could not discover jwks_uri for issuer https://auth.example.com/` |
| `STARTUP_ABORTED` | OAG-MCP received `SIGINT` or `SIGTERM` while starting. | Any | None needed: it was asked to stop. | `Start-up was cancelled before the index stage` |

An error printed as `Error: …`, without a code, comes from outside these
checks: `stdout` or `fd:1` given as a log destination, which OAG-MCP refuses
because stdout carries MCP messages, or a failure OAG-MCP did not anticipate.
For the latter, run again with `--log-level debug` and see
[Troubleshooting](../troubleshooting.md).
