# Upstream OAuth2

Some APIs take OAuth2 access tokens issued to a client application through the
*client credentials* flow: the application presents its client id and secret
to a token endpoint and gets a short-lived token back. This recipe has
OAG-MCP do that for the API it calls. For API keys, bearer tokens and basic
authentication, see [Upstream credentials](upstream-credentials.md).

The OpenAPI Generator typescript-fetch SDK cannot obtain tokens itself; it
only sends a token it is given. OAG-MCP therefore runs the flow itself:

- It requests a token the first time an operation needs one, with that
  operation's scopes, and caches it.
- It reuses the token until 30 seconds before it expires, then requests a new
  one. Calls that need a token at the same time share one request.
- If the API rejects a token with HTTP 401, OAG-MCP discards it, so the next
  call gets a new one.
- The client secret and the tokens stay inside OAG-MCP. The agent never sees
  them, and they never appear in logs.

Only the client credentials flow is supported: it needs no user to sign in.
Flows that do (authorization code, device code) are not.

## The OAuth2 scheme

The OpenAPI document declares the scheme, its token URL and its scopes; the
Pet Clinic API that OAG-MCP's tests use has:

```yaml
components:
  securitySchemes:
    clinicOAuth:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: https://auth.example.com/oauth/token
          scopes:
            pets:read: Read pets
            pets:write: Register pets
paths:
  /pets:
    post:
      operationId: createPet
      security:
        - clinicOAuth: [pets:write]
```

`PetsApi.createPet` needs a `clinicOAuth` token with the `pets:write` scope.

## Configuration

Register a client application for OAG-MCP with your authorization server,
then save this as `oag-mcp.oauth.yaml`:

```yaml
upstreamAuth:
  schemes:
    clinicOAuth:                        # the scheme name from your OpenAPI document
      clientId: { env: CLIENT_ID }
      clientSecret: { env: CLIENT_SECRET }
      # optional:
      tokenUrl: https://auth.example.com/oauth/token   # default: the scheme's tokenUrl
      scopes: [pets:read, pets:write]   # default: the scopes of the operation being called
      audience: https://api.example.com # added to the token request, for servers that need it
      clientAuthMethod: client_secret_basic   # or client_secret_post
```

| Property | Default | Use |
| --- | --- | --- |
| `clientId`, `clientSecret` | (required) | The client application's credentials, as secret references. |
| `tokenUrl` | The scheme's `tokenUrl` in the OpenAPI document | When the document's URL is wrong for your environment, or relative. |
| `scopes` | The scopes the called operation requires | To request one token with fixed scopes for every operation. |
| `audience` | None | Authorization servers such as Auth0 that need an `audience` parameter. |
| `clientAuthMethod` | `client_secret_basic` | `client_secret_post` sends the id and secret in the request body, for servers that do not accept HTTP Basic. |

The token URL must be HTTPS, or on a loopback address. A plain `http://`
token URL elsewhere would send the client secret unencrypted, so OAG-MCP
refuses to start:

```text
Error [UPSTREAM_AUTH_CONFIG_INVALID]: Invalid upstreamAuth configuration: clinicOAuth: token URL http://auth.example.test is not HTTPS (set upstreamAuth.allowInsecureTokenUrl only for local testing)
Hint: See docs/authentication.md#upstream-auth.
```

An OAuth2 scheme can be combined with any of the schemes in
[Upstream credentials](upstream-credentials.md): each operation uses the one
its OpenAPI `security` names.

## Running it

```bash
export CLIENT_ID=… CLIENT_SECRET=…
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --config ./oag-mcp.oauth.yaml \
  --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

No token is requested at start-up: the first call that needs one requests
it, so a wrong client secret shows up on that call, not when OAG-MCP starts.

## What the logs show

The examples below come from the Pet Clinic API, with the agent calling
`PetsApi.createPet` five times. The test's authorization server issued tokens
valid for 32 seconds, so that the cached token would need replacing within the
session; real tokens usually last an hour or more. This `jq` command prints
one line per record:

```bash
tail -f oag-mcp.log | jq -r 'if .class_uid
  then "audit        \(.metadata.event_code) \(.api.operation // "") \(if (.metadata.event_code | startswith("authorization")) then "" else .status_detail // "" end)"
  else "operational  \(.EventName) \(.Attributes["oag_mcp.operation"] // "") \(.Attributes["http.response.status_code"] // "")"
  end'
```

### The token's life

```text
audit        upstream.token.issue
audit        authorization.allowed PetsApi.createPet
operational  upstream.call.completed PetsApi.createPet 201

operational  upstream.token.cache_hit
audit        authorization.allowed PetsApi.createPet
operational  upstream.call.completed PetsApi.createPet 201

audit        upstream.token.refresh
audit        authorization.allowed PetsApi.createPet
operational  upstream.call.completed PetsApi.createPet 201

operational  upstream.token.cache_hit
audit        authorization.allowed PetsApi.createPet
audit        upstream.token.invalidated upstream_rejected_credentials
operational  upstream.call.completed PetsApi.createPet 401

audit        upstream.token.issue
audit        authorization.allowed PetsApi.createPet
operational  upstream.call.completed PetsApi.createPet 201
```

1. The first call needs a token, so OAG-MCP requests one: `upstream.token.issue`.
2. The second call reuses it. `upstream.token.cache_hit` is a `debug`
   record, shown only with `--log-level debug`.
3. Two seconds later the token is within 30 seconds of expiring, so the third
   call gets a new one: `upstream.token.refresh`.
4. Before the fourth call, the authorization server revoked its tokens. The
   API answers 401, OAG-MCP discards the cached token
   (`upstream.token.invalidated`), and the agent receives the 401 as an
   `api_error`. The call is not retried, since it may not be safe to repeat.
5. The fifth call requests a new token and succeeds.

`upstream.token.issue` records the scheme, the token's lifetime and how long
the request took; the caller and client are those of the MCP request that
needed the token:

```json
{
  "time_dt": "2026-10-29T10:04:37.849Z",
  "class_name": "Authentication",
  "activity_name": "Token Issue",
  "status": "Success",
  "duration": 61,
  "metadata": { "event_code": "upstream.token.issue", "correlation_uid": "req_324ff8ae-4d66-4279-96e2-3167467a2d75", "…": "…" },
  "actor": { "user": { "uid": "local:local" } },
  "user": { "uid": "service-identity", "type_id": 4, "type": "Service" },
  "service": { "name": "clinicOAuth" },
  "auth_protocol": "OAUTH 2.0",
  "src_endpoint": { "name": "stdio" },
  "unmapped": {
    "executionId": "exec_d9d37be3-2481-42a7-b290-9f814fecd224",
    "expiresInSec": 32,
    "scopeCount": 1
  },
  "message": "upstream.token.issue"
}
```

`user` is OAG-MCP's own service identity, which authenticated to the token
endpoint; `actor` is the MCP caller whose call needed the token. The token
itself is never logged.

### When the token endpoint refuses

With a wrong client secret, the token endpoint answers 401. The call fails
without reaching the API:

```text
audit        upstream.token.issue_failed token_endpoint_error
audit        credential.lookup_failed PetsApi.createPet token_request_failed
```

The audit record carries the endpoint's HTTP status and OAuth error code:

```json
{
  "class_name": "Authentication",
  "activity_name": "Token Issue",
  "status": "Failure",
  "status_detail": "token_endpoint_error",
  "status_code": "401",
  "metadata": { "event_code": "upstream.token.issue_failed", "…": "…" },
  "user": { "uid": "service-identity", "type_id": 4, "type": "Service" },
  "service": { "name": "clinicOAuth" },
  "unmapped": { "oauthError": "invalid_client", "…": "…" },
  "message": "upstream.token.issue_failed"
}
```

and the agent receives an `upstream_auth_error`:

```json
{
  "type": "upstream_auth_error",
  "reason": "token_request_failed",
  "operation": "PetsApi.createPet",
  "message": "The OAuth2 token endpoint rejected the client credentials request for \"clinicOAuth\" (HTTP 401)",
  "name": "OagMcpBrokerError"
}
```

`invalid_client` means the client id or secret is wrong; `invalid_scope`
means the client may not request the operation's scopes, which `scopes` in
the configuration can fix. If the token endpoint cannot be reached at all,
the reason is `token_endpoint_unreachable`.

The [log events reference](../reference/log-events.md) describes every record,
and the [error types reference](../reference/error-types.md) every error.
