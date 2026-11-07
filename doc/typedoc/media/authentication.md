# Authentication

OAG-MCP sits between two parties that each need credentials, and handles
them separately:

| | MCP Auth | Upstream Auth |
| --- | --- | --- |
| Question | Who is calling OAG-MCP? | How does OAG-MCP prove itself to your API? |
| Direction | Inbound: MCP client to OAG-MCP | Outbound: OAG-MCP to the upstream API |
| Configuration | `mcpAuth` | `upstreamAuth` |
| Credentials come from | The MCP client's bearer token, or the operating system's process boundary for stdio | The configuration file, as references to environment variables or a secrets file |
| Result | A *principal*: the authenticated caller | Credentials added to each SDK call |

The two never mix. **An MCP access token is never forwarded to the API**, and
is never used as an upstream credential: a token issued for OAG-MCP is not
valid for your API just because the same client presented it. Likewise, the
upstream credentials are never shown to the MCP client or the agent's code.

## MCP Auth

MCP Auth decides who may use OAG-MCP's tools. Its result is a principal: an
id, plus the scopes and client id that came with the caller's credentials.
Every tool call runs as that principal, and audit records name it. What the
principal may then do is decided by [authorisation](authorisation.md).

| How the caller connects | Authenticated by | Principal id | Scopes |
| --- | --- | --- | --- |
| stdio | The operating system: the caller is the process that started OAG-MCP | `local:<mcpAuth.stdio.principal>` (`local:local` by default) | `mcpAuth.stdio.scopes` |
| Streamable HTTP, `mcpAuth.mode: none` | Nobody; loopback addresses only | `anonymous` | None |
| Streamable HTTP, `mcpAuth.mode: static-bearer` | A pre-shared bearer token | `static:<principal>` | The token's `scopes` |
| Streamable HTTP, `mcpAuth.mode: oauth` | An OAuth 2.0 access token from your authorization server | `oauth:<hash of issuer and subject>` | The token's scopes, and its client id |

### stdio

With the stdio transport, the MCP client starts OAG-MCP as a subprocess and
talks to it over stdin and stdout. Only that process can reach it, so the
operating system's process boundary is the access control and there is no
token. The session runs as one principal for its whole life,
`local:<mcpAuth.stdio.principal>`, with `mcpAuth.stdio.scopes`, just as an
HTTP caller runs as the principal its token names.
`mcpAuth.mode` has no effect on stdio.

### Streamable HTTP

Over HTTP, every request to the MCP endpoint is authenticated on its own:
OAG-MCP serves requests without sessions, so there is no session id to
mistake for a credential. Tokens are accepted only in the `Authorization`
header; a token in the URL query is refused with `400`, since URLs end up in
logs and browser history. The [HTTP endpoints reference](reference/http-endpoints.md)
lists every response.

**`none`** authenticates nobody, for local development. It is allowed only
on a loopback address: OAG-MCP refuses to start with `none` on any other
address, and records why in the audit log.

**`static-bearer`** maps pre-shared tokens, at least 16 characters each, to
named principals, each with optional scopes. Tokens are compared in constant
time. A missing or wrong token gets `401` with
`WWW-Authenticate: Bearer realm="oag-mcp"`. It suits clients that can be
configured with an `Authorization` header; it does not offer the MCP OAuth
discovery and sign-in flow.

**`oauth`** makes OAG-MCP an OAuth 2.0 resource server, as the MCP
authorization specification describes:

- **Discovery.** OAG-MCP publishes protected resource metadata (RFC 9728) at
  `/.well-known/oauth-protected-resource` and its path-specific form, such as
  `/.well-known/oauth-protected-resource/mcp`, naming your authorization
  server. MCP clients read it to find out where to get a token.
- **Challenges.** A missing or invalid token gets `401 invalid_token`, and a
  token without the required scopes `403 insufficient_scope`, each with a
  `WWW-Authenticate` header that points to the metadata.
- **Validation of every request.** JWT access tokens are checked against the
  authorization server's keys (configured, or discovered from the issuer):
  signature and algorithm, issuer, audience (the resource, or configured
  audiences), expiry and not-before, with a clock tolerance. Opaque tokens
  are checked by token introspection (RFC 7662): active, issuer, audience
  and expiry. Every token must carry `mcpAuth.oauth.requiredScopes`.
- **Private principals.** The principal id is a hash of the issuer and
  subject, so logs never record a personal identifier.

OAG-MCP is not an authorization server and needs no particular provider: any
issuer with published keys or an introspection endpoint works, including
self-hosted ones such as Keycloak, Authentik, Ory Hydra and Zitadel.

### HTTPS

OAG-MCP serves plain HTTP. For anything beyond loopback, terminate TLS in a
reverse proxy (Caddy, nginx, Traefik or a cloud load balancer), set
`http.publicUrl` to the external `https://` URL, which becomes the OAuth
resource identifier, and set `http.allowedHosts` so the `Host` header is
checked. The [remote server recipe](recipes/remote-server.md) walks through
it.

## Upstream Auth

Upstream Auth supplies the credentials your API expects. They are
configured per OpenAPI security scheme under `upstreamAuth.schemes`, loaded
at start-up from environment variables or a secrets file, and kept in
OAG-MCP's own process. For each SDK call, the broker works out which scheme
the operation needs and adds its credentials to the request on its way out.
The agent's code never sees them.

### Supported schemes

| OpenAPI scheme | Configuration | Sent as |
| --- | --- | --- |
| None | None | No credentials |
| `apiKey` in `header` | `apiKey` | The header the scheme names |
| `apiKey` in `query` | `apiKey` | The query parameter the scheme names |
| `http` `basic` | `username`, `password` | `Authorization: Basic …` |
| `http` `bearer` | `token` | `Authorization: Bearer …` |
| `oauth2` `clientCredentials` | `clientId`, `clientSecret`; optionally `tokenUrl`, `scopes`, `audience`, `clientAuthMethod` | `Authorization: Bearer …`, with a token OAG-MCP obtains itself |

The typescript-fetch SDK only sends a token it is given; it cannot obtain
one. So for OAuth2, OAG-MCP runs the client credentials flow itself: it
requests a token when an operation first needs one, caches it until 30
seconds before it expires, shares one request between calls that need a
token at the same time, and discards the token if the API rejects it with
`401`. The [upstream OAuth2 recipe](recipes/upstream-oauth.md) shows it in
the logs, and the [upstream credentials recipe](recipes/upstream-credentials.md)
covers the other schemes.

**Not supported:** `apiKey` in a cookie; HTTP schemes other than basic and
bearer, such as digest; OAuth2 flows that need a person to sign in
(authorization code, implicit, password, device code); `openIdConnect`; and
`mutualTLS`. An operation that accepts only these fails with
`upstream_auth_error` (`unsupported_scheme`), and `search` shows it as
unsupported.

### Choosing the credentials for a call

An operation's OpenAPI `security` (or the document's global one) can list
several alternatives. For each SDK call, the broker:

1. tries the alternatives in document order, and uses the first whose
   schemes are all supported and configured;
2. uses the empty alternative `{}`, meaning no authentication, only when no
   authenticated alternative is configured, so a call is never quietly sent
   without credentials it could have had;
3. refuses the call with `upstream_auth_error` (`credential_not_configured`)
   before it reaches the API, when the operation needs authentication and
   none is configured.

### One identity for every caller

Every MCP caller shares the same upstream credentials: OAG-MCP calls your
API as one *service identity*, and says so at start-up in the
`credential.provider.configured` audit record (`sharedIdentity: true`). The
API therefore sees OAG-MCP, not the individual caller, so any per-caller
limits must come from OAG-MCP's [authorisation](authorisation.md) rules.
Passing callers' own tokens through to the API is deliberately not
supported. Per-caller upstream credentials can be added by implementing a
`CredentialProvider` (`lib/upstream/types.ts`), which receives the caller's
principal and the operation. [ADR 0006](decisions/0006-shared-upstream-identity.md)
records why.

### Keeping credentials secret

- Credentials exist only in OAG-MCP's own process. The sandbox's SDK is
  configured with the base URL and a bridge to the broker, nothing else.
- Credentials the agent's code tries to supply itself are removed before the
  request is sent, and the removal is audited: `Authorization`, `Cookie`,
  `Proxy-Authorization`, and the header and query names of the document's
  API key schemes.
- Redirects to the same origin keep the credentials. Redirects to another
  origin are refused unless it is in `upstream.allowedOrigins`, and then the
  credentials are removed.
- `Set-Cookie` headers in API responses are dropped.
- Every credential OAG-MCP resolves and every token it obtains is scrubbed
  from logs, errors and tool results, so an API that echoes a token back
  shows `[REDACTED]`. See [Logging](logging.md#what-is-never-logged).
- Each execution has its own sandbox process and broker context, bound to its
  caller, so concurrent callers cannot see each other's calls.

[Security](security.md) describes how authentication fits with OAG-MCP's
other protections.
