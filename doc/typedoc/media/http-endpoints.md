# HTTP endpoints reference

With `--transport streamable-http`, OAG-MCP serves plain HTTP on
`--host` and `--port` (by default `127.0.0.1:3000`). This page lists the
paths it answers, the checks every request goes through, and the responses
it refuses with. For HTTPS, put a TLS-terminating reverse proxy in front; see
the [remote server recipe](../recipes/remote-server.md).

## Endpoints

| Path | Methods | Authentication | Description |
| --- | --- | --- | --- |
| `/mcp`, or `--path` (`http.path`) | `POST` | Per `mcpAuth.mode` | The MCP endpoint, per the MCP Streamable HTTP transport. Each request carries a JSON-RPC message and is answered on its own, without sessions, so `GET` and `DELETE` (for server-initiated streams and ending sessions) answer `405`. The client must send `Content-Type: application/json` and accept both `application/json` and `text/event-stream`; the reply is a `text/event-stream` carrying the JSON-RPC response. |
| `/healthz` | Any | None | Answers `200` with `{"status":"ok"}` once the server is serving. For load balancer and container health checks. |
| `/.well-known/oauth-protected-resource`, and the same followed by the MCP path, such as `/.well-known/oauth-protected-resource/mcp` | Any | None | With `mcpAuth.mode: oauth` only: the protected resource metadata (RFC 9728) that tells MCP clients which authorization server issues tokens for this server. Absent in other modes, where these paths answer `404`. |

Any other path answers `404` with `{"error":"not_found"}`.

The protected resource metadata names the resource, its authorization
server, the scopes and how tokens are sent:

```json
{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["mcp:use"],
  "bearer_methods_supported": ["header"]
}
```

`resource` is `mcpAuth.oauth.resource`, or `http.publicUrl`, or the local
endpoint URL. `scopes_supported` is `mcpAuth.oauth.scopesSupported`, or
`mcpAuth.oauth.requiredScopes`. `resource_name` is added when configured.

## Request checks

Every request, to any path, goes through these checks in order. The first
that fails decides the response:

1. **Host.** The `Host` header must be allowed, which defeats DNS
   rebinding. On a loopback address, the localhost names and
   `http.allowedHosts` are allowed. On any other address, only
   `http.allowedHosts`, and with none configured no check is made.
2. **Origin.** A request with an `Origin` header, which browsers send, must
   come from an allowed origin: exactly `http.allowedOrigins` (scheme, host
   and port) when configured, otherwise localhost origins on a loopback
   address and none elsewhere. Requests without `Origin` pass.
3. **No token in the URL.** A query with `access_token` or `token` is
   refused, since URLs end up in logs and browser history.
4. **The path.** `/healthz` and the OAuth metadata are answered here, without
   authentication; an unknown path answers `404`.
5. **Authentication** of requests to the MCP endpoint, by `mcpAuth.mode`.
6. **The MCP request** itself: method, headers and body size
   (`http.maxBodyBytes`).

Because the Host check comes first, a health check must send a `Host` the
server allows, such as the public name behind a proxy.

## Responses

The responses OAG-MCP refuses a request with, and the security audit event
each records:

| Status | When | Body | Audit event |
| --- | --- | --- | --- |
| `400 Bad Request` | The URL query carries `access_token` or `token`. | `{"error":"invalid_request","error_description":"Access tokens must be sent in the Authorization header"}` | `authentication.token_in_url_rejected` |
| `401 Unauthorized` | No bearer token, or an invalid or expired one. The `WWW-Authenticate` header carries the challenge: `Bearer realm="oag-mcp"` with `static-bearer`, and with `oauth` a `resource_metadata` URL pointing to the metadata above. | An OAuth error object, such as `{"error":"unauthorized","error_description":"Bearer token required"}` or `{"error":"invalid_token","error_description":"The bearer token is invalid"}` | `authentication.failed` |
| `403 Forbidden` | `Host` not allowed. | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: evil.example"},"id":null}` | `transport.host_rejected` |
| `403 Forbidden` | `Origin` not allowed. | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Origin: evil.example"},"id":null}` | `transport.origin_rejected` |
| `403 Forbidden` | With `oauth`, a valid token without `mcpAuth.oauth.requiredScopes`. `WWW-Authenticate` says `insufficient_scope`. | `{"error":"insufficient_scope","error_description":"…"}` | `authentication.failed` |
| `404 Not Found` | An unknown path. | `{"error":"not_found"}` | None |
| `405 Method Not Allowed` | A method other than `POST` on the MCP endpoint. | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}` | None |
| `406 Not Acceptable` | The client does not accept both `application/json` and `text/event-stream`. | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}` | None |
| `413 Payload Too Large` | The body is larger than `http.maxBodyBytes` (1 MiB by default). | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Payload Too Large: Request body must not exceed 1048576 bytes"},"id":null}` | None |
| `415 Unsupported Media Type` | The body is not `application/json`. | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unsupported Media Type: Content-Type must be application/json"},"id":null}` | None |
| `500 Internal Server Error` | An unexpected failure handling the request. | `{"error":"server_error"}` | None; the operational record `transport.request_failed` |

Errors inside an MCP request, such as a failed `execute` call, are not HTTP
errors: they come back as a `200` carrying a tool result with
`isError: true`. See the [MCP tools reference](tools.md).
