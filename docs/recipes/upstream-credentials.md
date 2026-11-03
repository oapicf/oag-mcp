# Upstream API credentials

Most APIs need credentials: an API key, a bearer token, or a user name and
password. This recipe configures them for the API OAG-MCP calls. For OAuth2
client credentials, see [Upstream OAuth2](upstream-oauth.md).

OAG-MCP holds the credentials itself and adds them to each request on its
way to the API, so the agent never sees them:

- They are configured per OpenAPI security scheme, and applied to each SDK
  call according to the security requirement of its operation in the OpenAPI
  document.
- The configuration file only references them: the values come from
  environment variables or a protected secrets file when OAG-MCP starts.
- The agent's code gets an SDK configured with the API's base URL and
  nothing else. Credentials it adds itself, such as an `Authorization`
  header, are removed before the request is sent.
- Credentials never appear in logs, errors or tool results.

Every caller shares these credentials: the API sees OAG-MCP's one identity.
To control what each caller may do, see
[Per-caller permissions](per-caller-permissions.md).

## Finding your security schemes

Credentials are keyed by the names under `components.securitySchemes` in your
OpenAPI document. The Pet Clinic API that OAG-MCP's tests use has these:

```yaml
components:
  securitySchemes:
    apiKeyHeader: { type: apiKey, in: header, name: X-Api-Key }
    apiKeyQuery: { type: apiKey, in: query, name: api_key }
    bearerAuth: { type: http, scheme: bearer }
    adminBasic: { type: http, scheme: basic }
```

Each operation's `security` (or the document's global `security`) says which
schemes it needs. Here `GET /pets` takes `apiKeyHeader` or `bearerAuth`,
`GET /owners` takes `apiKeyQuery`, and `DELETE /pets/{petId}` takes
`adminBasic`.

| Scheme type | Configure | Sent as |
| --- | --- | --- |
| `apiKey` in a header or query | `apiKey` | the header or query parameter the scheme names |
| `http` `bearer` | `token` | `Authorization: Bearer …` |
| `http` `basic` | `username`, `password` | `Authorization: Basic …` |
| `oauth2` client credentials | see [Upstream OAuth2](upstream-oauth.md) | `Authorization: Bearer …`, with a token OAG-MCP obtains |

Cookie API keys, other HTTP schemes and interactive OAuth2 flows are not
supported; [Authentication](../authentication.md#upstream-api-authentication)
lists what is.

## Configuration

Save this as `oag-mcp.credentials.yaml`, using your scheme names:

```yaml
upstream:
  baseUrl: https://api.example.com/v1   # optional: defaults to the OpenAPI document's first server

upstreamAuth:
  secretsFile: ./secrets.yaml           # only needed for { secret: … } references
  schemes:
    apiKeyHeader:
      apiKey: { env: API_KEY }          # from the API_KEY environment variable
    apiKeyQuery:
      apiKey: { env: API_KEY }          # the same key, for operations that take it in the query
    bearerAuth:
      token: { env: API_TOKEN }
    adminBasic:
      username: { env: ADMIN_USER }
      password: { secret: admin_password }   # from the secrets file
```

A credential can come from two places:

- `{ env: NAME }`: the environment variable `NAME` of the OAG-MCP process.
  Good for containers and CI, where secrets are injected as environment
  variables.
- `{ secret: key }`: the value of `key` in `upstreamAuth.secretsFile`, a YAML
  or JSON map. The path is relative to the configuration file. OAG-MCP
  refuses to start if the file is readable by anyone but its owner:

  ```bash
  printf 'admin_password: %s\n' "$ADMIN_PASSWORD" > secrets.yaml
  chmod 600 secrets.yaml
  ```

Configure only the schemes your operations need. An operation whose schemes
are not configured fails when called, without contacting the API; OAG-MCP
never falls back to calling it without credentials.

## Running it

```bash
export API_KEY=… API_TOKEN=… ADMIN_USER=…
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --config ./oag-mcp.credentials.yaml \
  --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

OAG-MCP reads every referenced credential at start-up, so a missing one stops
it straight away, before any MCP client connects:

```text
Error [UPSTREAM_AUTH_CONFIG_INVALID]: Invalid upstreamAuth configuration: bearerAuth: Environment variable API_TOKEN (for bearerAuth.token) is not set
Hint: See docs/authentication.md#upstream-api-authentication.
```

```text
Error [UPSTREAM_AUTH_CONFIG_INVALID]: Invalid upstreamAuth configuration: adminBasic: Secrets file /srv/oag-mcp/secrets.yaml is readable by group or others (mode 644)
Hint: See docs/authentication.md#upstream-api-authentication.
```

A scheme name that is not in the OpenAPI document is refused the same way,
so a typo cannot go unnoticed.

## What the logs show

The examples below come from the Pet Clinic API with the configuration above.
This `jq` command prints one line per record:

```bash
tail -f oag-mcp.log | jq -r 'if .class_uid
  then "audit        \(.metadata.event_code) \(.api.operation // "") \(.unmapped.schemes // "" | tostring) \(.action // "")"
  else "operational  \(.EventName) \(.Attributes["oag_mcp.operation"] // "") \(.Attributes["http.response.status_code"] // "")"
  end'
```

### At start-up

`credential.provider.configured` lists the schemes OAG-MCP has credentials
for, and states that every caller shares them:

```json
{
  "class_name": "Application Lifecycle",
  "activity_name": "Configure",
  "status": "Success",
  "metadata": { "event_code": "credential.provider.configured", "…": "…" },
  "unmapped": {
    "provider": "service-identity",
    "schemes": ["apiKeyHeader", "apiKeyQuery", "bearerAuth", "adminBasic"],
    "sharedIdentity": true
  },
  "message": "credential.provider.configured"
}
```

### Each call

Every SDK call's `authorization.allowed` record lists the schemes whose
credentials were applied, never the credentials themselves. Four calls, each
needing a different scheme:

```text
audit        authorization.allowed PetsApi.listPets ["apiKeyHeader"] Allowed
operational  upstream.call.completed PetsApi.listPets 200
audit        authorization.allowed OwnersApi.listOwners ["apiKeyQuery"] Allowed
operational  upstream.call.completed OwnersApi.listOwners 200
audit        authorization.allowed StoreApi.getStoreInventory ["bearerAuth"] Allowed
operational  upstream.call.completed StoreApi.getStoreInventory 200
audit        authorization.allowed AdminApi.deletePet ["adminBasic"] Allowed
operational  upstream.call.completed AdminApi.deletePet 204
```

`PetsApi.listPets` accepts `apiKeyHeader` or `bearerAuth`, and both are
configured: OAG-MCP uses the first alternative in the operation's `security`
list whose schemes are all configured.

### Credentials added by the agent

If the agent's code passes credentials of its own, for example:

```ts
await sdk.PetsApi.listPets({ limit: 1 }, {
  headers: { Authorization: "Bearer agent-made-up-token" },
});
```

the header is removed, the configured credentials are applied instead, and
the decision is recorded as `Modified` instead of `Allowed`:

```json
{
  "class_name": "API Activity",
  "activity_name": "Read",
  "status": "Success",
  "metadata": { "event_code": "authorization.allowed", "…": "…" },
  "api": { "operation": "PetsApi.listPets", "…": "…" },
  "action": "Modified",
  "disposition": "Corrected",
  "unmapped": {
    "provider": "service-identity",
    "schemes": ["apiKeyHeader"],
    "unauthenticated": false,
    "strippedCredentials": ["authorization"]
  },
  "message": "authorization.allowed"
}
```

`strippedCredentials` names what was removed, never its value.

### When a call has no credentials

If an operation needs a scheme that is not configured, here `bearerAuth` for
`StoreApi.getStoreInventory`, the call fails before reaching the API:

```text
audit        credential.lookup_failed StoreApi.getStoreInventory
```

and the agent receives an `upstream_auth_error` naming the schemes to
configure:

```json
{
  "type": "upstream_auth_error",
  "reason": "credential_not_configured",
  "operation": "StoreApi.getStoreInventory",
  "message": "No upstream credentials are configured for this operation; configure one of: bearerAuth under upstreamAuth.schemes",
  "name": "OagMcpBrokerError"
}
```

### When the API rejects the credentials

A wrong or revoked credential is sent, and the API's answer comes back to the
agent as it is:

```text
audit        authorization.allowed PetsApi.listPets ["apiKeyHeader"] Allowed
operational  upstream.call.completed PetsApi.listPets 401
```

```json
{
  "type": "api_error",
  "name": "ResponseError",
  "message": "The API responded with HTTP 401 Unauthorized",
  "status": 401,
  "body": "{\"code\":\"unauthorized\",\"message\":\"missing or invalid credentials\"}",
  "line": 1,
  "column": 13
}
```

OAG-MCP cannot tell a bad key from any other 401, so check the credential's
value when every call to one scheme's operations fails this way.

The [log events reference](../reference/log-events.md) describes every record,
and the [error types reference](../reference/error-types.md) every error.
