# MCP Auth and Upstream Auth combinations

OAG-MCP authenticates two things separately: the MCP client calling it, by
[MCP Auth](../authentication.md#mcp-auth), and itself to your API, by
[Upstream Auth](../authentication.md#upstream-auth). Every MCP Auth mode
works with every upstream scheme, and neither affects the other. This recipe
has a ready-to-run example for each of the 24 combinations, in
`examples/auth-combinations/`, and shows how to check the identity of the
agent, OAG-MCP and the API in each.

## Pick your combination

Find how your MCP clients will connect (the row) and how your API
authenticates its callers (the column):

| MCP Auth ↓ / Upstream Auth → | None | API key in a header | API key in the query | HTTP basic | HTTP bearer | OAuth2 client credentials |
| --- | --- | --- | --- | --- | --- | --- |
| **stdio** | [example](../../examples/auth-combinations/mcp-stdio-upstream-none/) | [example](../../examples/auth-combinations/mcp-stdio-upstream-api-key-header/) | [example](../../examples/auth-combinations/mcp-stdio-upstream-api-key-query/) | [example](../../examples/auth-combinations/mcp-stdio-upstream-basic/) | [example](../../examples/auth-combinations/mcp-stdio-upstream-bearer/) | [example](../../examples/auth-combinations/mcp-stdio-upstream-oauth2-client-credentials/) |
| **none** | [example](../../examples/auth-combinations/mcp-none-upstream-none/) | [example](../../examples/auth-combinations/mcp-none-upstream-api-key-header/) | [example](../../examples/auth-combinations/mcp-none-upstream-api-key-query/) | [example](../../examples/auth-combinations/mcp-none-upstream-basic/) | [example](../../examples/auth-combinations/mcp-none-upstream-bearer/) | [example](../../examples/auth-combinations/mcp-none-upstream-oauth2-client-credentials/) |
| **static bearer** | [example](../../examples/auth-combinations/mcp-static-bearer-upstream-none/) | [example](../../examples/auth-combinations/mcp-static-bearer-upstream-api-key-header/) | [example](../../examples/auth-combinations/mcp-static-bearer-upstream-api-key-query/) | [example](../../examples/auth-combinations/mcp-static-bearer-upstream-basic/) | [example](../../examples/auth-combinations/mcp-static-bearer-upstream-bearer/) | [example](../../examples/auth-combinations/mcp-static-bearer-upstream-oauth2-client-credentials/) |
| **OAuth** | [example](../../examples/auth-combinations/mcp-oauth-upstream-none/) | [example](../../examples/auth-combinations/mcp-oauth-upstream-api-key-header/) | [example](../../examples/auth-combinations/mcp-oauth-upstream-api-key-query/) | [example](../../examples/auth-combinations/mcp-oauth-upstream-basic/) | [example](../../examples/auth-combinations/mcp-oauth-upstream-bearer/) | [example](../../examples/auth-combinations/mcp-oauth-upstream-oauth2-client-credentials/) |

Each folder is named `mcp-<MCP Auth>-upstream-<Upstream Auth>` and holds:

| File | What it is |
| --- | --- |
| `openapi.yaml` | A small Pet Store API, secured with the upstream scheme |
| `oag-mcp.config.yaml` | The OAG-MCP configuration for the combination |
| `generate-sdk.sh` | Generates the typescript-fetch SDK into `generated-sdk/`, with OpenAPI Generator 7.26.0 in Docker |
| `serve.sh` | Starts OAG-MCP with the document, the SDK and the configuration, checking that the secrets it needs are set |
| `README.md` | How to run it, connect a client, and check the identity |

To adapt a folder to your API, replace `openapi.yaml` with your own
document, rename the scheme under `upstreamAuth.schemes` to the one your
document declares, and point `upstream.baseUrl` at your API.

## The MCP Auth part

The row decides how the agent connects, how it is authenticated, and how the
logs name it:

| MCP Auth | The client connects | Authenticated by | Logs name the agent as | Set up in detail |
| --- | --- | --- | --- | --- |
| stdio | Over stdio, starting `serve.sh` itself | The operating system's process boundary | `local:<mcpAuth.stdio.principal>` | [Authentication](../authentication.md#stdio) |
| none | Over HTTP, to `http://127.0.0.1:3000/mcp` | Nothing; loopback addresses only | `anonymous` | [Authentication](../authentication.md#streamable-http) |
| static bearer | Over HTTP, with `Authorization: Bearer <token>` | A pre-shared token, `OAG_MCP_TOKEN` in the examples | `static:<principal>` | [Remote server](remote-server.md), [Per-caller permissions](per-caller-permissions.md) |
| OAuth | Over HTTP, with an access token from your authorization server | The token, validated as a JWT or by introspection | `oauth:<keyed hash of issuer and subject>` | [Per-caller permissions](per-caller-permissions.md#configuration-with-oauth) |

The OAuth examples validate JWTs, and show the introspection alternative in a
comment. Their `principalIdKey` keeps principal ids the same across restarts.

## The Upstream Auth part

The column decides what the API receives. OAG-MCP reaches the API as one
service identity, whichever agent is calling:

| Upstream Auth | Scheme in `openapi.yaml` | Secrets | The API receives | Set up in detail |
| --- | --- | --- | --- | --- |
| None | None | None | No credentials | |
| API key in a header | `apiKeyHeader`, `in: header` | `PETSTORE_API_KEY` | The key in the `X-Api-Key` header | [Upstream credentials](upstream-credentials.md) |
| API key in the query | `apiKeyQuery`, `in: query` | `PETSTORE_API_KEY` | The key in the `api_key` query parameter | [Upstream credentials](upstream-credentials.md) |
| HTTP basic | `basicAuth` | `PETSTORE_USERNAME`, `PETSTORE_PASSWORD` | `Authorization: Basic …` | [Upstream credentials](upstream-credentials.md) |
| HTTP bearer | `bearerAuth` | `PETSTORE_TOKEN` | `Authorization: Bearer …` | [Upstream credentials](upstream-credentials.md) |
| OAuth2 client credentials | `petstoreOAuth` | `PETSTORE_CLIENT_ID`, `PETSTORE_CLIENT_SECRET` | `Authorization: Bearer …`, with a token OAG-MCP obtains, caches and renews | [Upstream OAuth2](upstream-oauth.md) |

The agent's MCP credentials never reach the API, in any combination. With
static bearer or OAuth, and HTTP basic, bearer or OAuth2 upstream, both sides
use an `Authorization` header: OAG-MCP keeps the agent's for itself, and
sends only its own to the API.

## Check the identity

Every `serve.sh` writes its logs and security audit records to `oag-mcp.log`
in its folder. Each API call is recorded in an `authorization.allowed`
record, which names both sides of the combination:

| Field | Tells you |
| --- | --- |
| `actor.user.uid` | The agent, as the MCP Auth row names it |
| `metadata.reporter.uid` | The OAG-MCP process, by its instance id |
| `api.operation` | The SDK method the agent called |
| `unmapped.schemes` | The upstream scheme whose credentials were sent: the column's scheme name, or `[]` for none |
| `unmapped.strippedCredentials` | Credentials the agent's code tried to set itself, which were removed |

To list who made each API call, and with which credentials:

```bash
jq -r 'select(.metadata.event_code == "authorization.allowed")
  | "\(.time_dt) \(.actor.user.uid) \(.api.operation) \(.unmapped.schemes | join(","))"' oag-mcp.log
```

With MCP Auth static bearer and Upstream Auth API key in a header, for
example, a call to list pets shows:

```text
2026-11-13T00:20:41.512Z static:petstore-agent PetsApi.listPets apiKeyHeader
```

Each folder's README gives the values to expect for its combination.
[Identity](../identity.md) explains these records, how to trace an OAuth
principal to a user, and what the API can and cannot see.

## How the combinations are tested

Two integration tests cover every combination:

- `test-integration/auth-combinations.ts` makes calls through OAG-MCP for
  each MCP Auth mode, OAuth with JWTs and with introspection included, with
  each upstream scheme, against the Pet Clinic fixture.
- `test-integration/auth-combinations-examples.ts` runs every folder here:
  its own `serve.sh`, with the SDK generated from its `openapi.yaml`, a
  client connected as its README says, and every API operation called.

Both check that the API received exactly the scheme's credentials and never
the MCP token, and that the audit records name the expected principal and
scheme. See [Testing](../testing.md#what-the-integration-tests-verify).
