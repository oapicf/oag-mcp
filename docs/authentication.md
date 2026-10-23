# Authentication and authorization

oag-mcp has two independent layers with separate configuration namespaces:

| Layer | Namespace | Protects | Credentials come from |
| --- | --- | --- | --- |
| MCP access | `mcpAuth` | callers of the oag-mcp server | the MCP client (bearer token) or the OS process boundary (stdio) |
| Upstream API | `upstreamAuth` | your API | runtime configuration (env vars / secrets file) |

**An MCP access token is never forwarded upstream** and is never treated as
an upstream credential. Upstream credentials are attached by the trusted
host-side broker; agent code never sees them.

## MCP access

### stdio

The caller is the process that spawned the server; access control is the
local OS boundary. There is no HTTP OAuth handshake. The session principal is
`local:<mcpAuth.stdio.principal>` with `mcpAuth.stdio.scopes`, so the
authorization policy applies to stdio callers too. Upstream credentials are
loaded at startup from environment variables or the secrets file; the
executor never inherits the server's environment.

### Streamable HTTP

Every request to the MCP endpoint is authenticated; session identifiers are
not credentials (the server runs in stateless mode). Tokens are only accepted
in the `Authorization` header — `?access_token=` is rejected with `400`.

| `mcpAuth.mode` | Use | Behaviour |
| --- | --- | --- |
| `none` | local development | allowed only on loopback; binding `0.0.0.0` (or any non-loopback address) is refused and audited |
| `static-bearer` | simple deployments whose clients can set an `Authorization` header | pre-shared tokens (≥ 16 chars) mapped to named principals; constant-time comparison; `401` with `WWW-Authenticate: Bearer realm="oag-mcp"`. **Does not implement the MCP OAuth discovery/authorization flow.** |
| `oauth` | standards-based deployments | OAuth 2.0 resource server per the MCP authorization spec (below) |

#### OAuth resource server

- **Discovery**: RFC 9728 protected resource metadata at
  `/.well-known/oauth-protected-resource` and the path-specific
  `/.well-known/oauth-protected-resource/mcp`, naming the configured
  authorization server.
- **Challenges**: `401 invalid_token` / `403 insufficient_scope` with
  `WWW-Authenticate: Bearer … resource_metadata="…"` (built with the
  official MCP TypeScript SDK's bearer helpers).
- **Validation** of every request:
  - JWT access tokens via the configured (or discovered) JWKS using `jose`:
    signature and algorithm allowlist, `iss` = issuer, `aud` includes the
    resource (or configured audiences), `exp` required, `nbf`, clock
    tolerance;
  - opaque tokens via **RFC 7662 introspection** (`mcpAuth.oauth.introspection`):
    `active`, issuer, audience and expiry are checked;
  - `requiredScopes` for using the server at all; per-operation permissions
    via `authorization` rules on token scopes and client id.
- Principals are identified by an opaque id derived from issuer + subject
  (`oauth:<hash>`), so logs do not record personal identifiers.
- oag-mcp does not implement an authorization server and needs no
  particular provider: any issuer with JWKS or introspection works,
  including self-hosted ones (Keycloak, Authentik, Ory Hydra, Zitadel, …).

### HTTPS

oag-mcp serves plain HTTP. For anything beyond loopback, terminate TLS in a
reverse proxy (Caddy, nginx, Traefik, a cloud load balancer), set
`http.publicUrl` to the external `https://` URL (it becomes the OAuth
resource identifier), and use `http.allowedHosts` for Host header validation.

## Upstream API authentication

Supported against typescript-fetch output (validated with the fixture
API in `test-integration/`):

| OpenAPI scheme | Config fields | Applied as |
| --- | --- | --- |
| none | — | no credentials |
| `apiKey` in `header` | `apiKey` | header named by the scheme |
| `apiKey` in `query` | `apiKey` | query parameter named by the scheme |
| `http` `basic` | `username`, `password` | `Authorization: Basic …` |
| `http` `bearer` | `token` | `Authorization: Bearer …` |
| `oauth2` `clientCredentials` | `clientId`, `clientSecret`, optional `tokenUrl`, `scopes`, `audience`, `clientAuthMethod` | tokens fetched by oag-mcp's credential provider, cached until 30 s before expiry, concurrent refreshes de-duplicated, invalidated on upstream `401` |

typescript-fetch only *reads* tokens from its `Configuration`; it has no
OAuth token flow. oag-mcp therefore implements client credentials in its own
credential provider instead of pretending the SDK handles it.

**Not supported** (operations requiring only these fail with
`upstream_auth_error` / `unsupported_scheme`; search shows them as
unsupported): `apiKey` in cookies, HTTP schemes other than basic/bearer
(digest, …), OAuth2 `authorizationCode`, `implicit`, `password` and device
flows (interactive login), `openIdConnect`, `mutualTLS`.

### Security requirement resolution

For each SDK call the broker uses the operation's effective requirement
(operation-level `security` overrides the global one):

1. alternatives are tried in document order; an alternative is usable only
   if **all** of its schemes are supported and configured;
2. the empty alternative `{}` ("no auth") is used only when no authenticated
   alternative is configured — oag-mcp never silently downgrades;
3. if the operation requires authentication and nothing is configured, the
   call fails with `credential_not_configured` before reaching the API.

### Identity model

Version one uses one explicitly configured **service identity**: all MCP
callers share the same upstream credentials (`sharedIdentity: true` is
audited at startup). Per-caller upstream authorization can be added by
implementing `CredentialProvider` (`lib/upstream/types.ts`), which
receives the request principal and operation. Arbitrary token passthrough is
deliberately not implemented.

## Permissions

A request-scoped `Principal` is created for every MCP request (stdio: per
session). The `authorization` policy (see
[configuration](configuration.md#authorization-patterns)) is applied:

- **search** results are filtered to operations the principal may call;
- **execute**: every SDK call is checked by the broker **before** credentials
  are fetched or the API is contacted. One execute call may contain many SDK
  calls; each one produces an `authorization.allowed` or
  `authorization.denied` audit record. Hiding a method from search is not the
  control — calling a hidden method directly is still denied.

## Credential confidentiality

- Credentials exist only in the host process (provider and broker); the
  sandbox gets an SDK `Configuration` containing only the base URL and the
  bridge fetch.
- The bridge strips `Authorization`, `Cookie`, `Proxy-Authorization` and the
  spec's apiKey header/query names supplied by agent code (audited).
- Same-origin redirects keep credentials; cross-origin redirects are denied
  unless the origin is in `upstream.allowedOrigins`, and then credentials are
  removed.
- `Set-Cookie` response headers are dropped.
- Every resolved secret and every issued token is registered with a
  scrubber applied to logs, errors and tool output (an API echoing a token
  back appears as `[REDACTED]`).
- Concurrent callers are isolated: each execution has its own process and
  broker context bound to its principal.
