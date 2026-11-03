# Decision records

Short records of OAG-MCP's significant design decisions: the problem, the
choice made, and its consequences, good and bad. A decision that is later
changed gets a new record, and the old one is marked as superseded.

| Record | Decision |
| --- | --- |
| [1. Code mode with two tools](0001-code-mode-with-two-tools.md) | `search` and `execute`, not a tool per operation. |
| [2. The real SDK in a Deno sandbox](0002-real-sdk-in-a-deno-sandbox.md) | Agent code and the SDK run without permissions; a host broker makes every API call. |
| [3. typescript-fetch SDKs only](0003-typescript-fetch-sdks-only.md) | One supported generator target, at tested versions. |
| [4. Bind methods by static analysis](0004-bind-methods-by-static-analysis.md) | Match SDK methods to operations by method and path, never by name. |
| [5. Prepare at start-up, without a cache](0005-prepare-at-start-up-without-a-cache.md) | Prepare each time the server starts, in a temporary workspace. |
| [6. One shared upstream identity](0006-shared-upstream-identity.md) | One service identity for all callers; no token passthrough. |
| [7. Logging in OpenTelemetry and OCSF](0007-logging-in-opentelemetry-and-ocsf.md) | Open standards for operational and audit records. |
| [8. Stateless Streamable HTTP](0008-stateless-streamable-http.md) | No MCP sessions; every request stands alone. |
| [9. TypeScript and the Olympia build](0009-typescript-and-olympia-build.md) | TypeScript on Olympia, and what changed from the template. |

To add a record, copy the shape of an existing one, `Status`, `Context`,
`Decision` and `Consequences`, and number it after the last.
