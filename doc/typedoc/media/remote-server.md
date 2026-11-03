# Remote server

By default OAG-MCP serves on the machine it runs on: over stdio, or over
Streamable HTTP on `127.0.0.1`. This recipe runs it as a shared server that
MCP clients on other machines reach over the network, at an address such as
`https://mcp.example.com/mcp`.

OAG-MCP serves plain HTTP, so a remote server needs a reverse proxy in front
of it to provide HTTPS, and it needs MCP authentication so that only your
callers can use it. OAG-MCP enforces the second itself: it refuses to listen
on a non-loopback address without `mcpAuth`. The pieces:

| Setting | Why |
| --- | --- |
| `--transport streamable-http` | MCP over HTTP. |
| `--host 0.0.0.0`, or the address the proxy reaches | Listen beyond loopback. |
| `mcpAuth.mode: static-bearer` or `oauth` | Authenticate every MCP request. Required for a non-loopback address. |
| A TLS-terminating reverse proxy | HTTPS for clients; OAG-MCP itself serves plain HTTP. |
| `http.publicUrl` | The URL clients use, so that OAuth metadata and token audiences name it rather than the internal address. |
| `http.allowedHosts` | The host names clients may use, checked against the `Host` header to defeat DNS rebinding. On a non-loopback address, **no `Host` check is made unless this is set.** |
| `http.allowedOrigins` | Browser origins allowed to call the server, if any browser-based client should. |

## Configuration

This example uses static bearer tokens; for OAuth, see
[Configuration with OAuth](per-caller-permissions.md#configuration-with-oauth).
Save it as `oag-mcp.remote.yaml`:

```yaml
upstreamAuth:
  schemes:
    apiKeyHeader:
      apiKey: { env: API_KEY }

mcpAuth:
  mode: static-bearer
  staticBearer:
    tokens:
      - principal: team-agent
        token: { env: MCP_TOKEN }

http:
  host: 0.0.0.0                          # or pass --host
  port: 3000
  publicUrl: https://mcp.example.com/mcp # what clients connect to
  allowedHosts: [mcp.example.com]        # the Host header clients send through the proxy
  allowedOrigins: [https://app.example.com]   # only if a browser-based client calls it
```

The same configuration is in [`examples/oag-mcp-remote-server.config.yaml`](../../examples/oag-mcp-remote-server.config.yaml).

Add `authorization` rules as in the [read-only](read-only.md),
[curated](curated.md) or [per-caller](per-caller-permissions.md) recipes:
anyone with a token can use whatever the rules allow.

## Running it

```bash
export API_KEY=… MCP_TOKEN=…
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --config ./oag-mcp.remote.yaml \
  --transport streamable-http \
  --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

OAG-MCP prints the address it listens on, which is the internal one:

```text
oag-mcp listening on http://0.0.0.0:3000/mcp
```

Without `mcpAuth`, it refuses to start:

```text
Error [MCP_AUTH_REQUIRED]: Refusing to serve unauthenticated MCP on non-loopback address 0.0.0.0
Hint: Bind to 127.0.0.1, or configure mcpAuth.mode static-bearer or oauth. Terminate TLS in front of the server for remote access.
```

## The reverse proxy

The proxy terminates TLS and forwards to OAG-MCP. Two things matter:

- **Keep the client's `Host` header.** OAG-MCP checks it against
  `http.allowedHosts`, so the proxy must forward `mcp.example.com`, not the
  internal address. Caddy does so by default; nginx needs
  `proxy_set_header Host $host`.
- **Do not buffer responses.** Streamable HTTP answers with a stream of
  server-sent events, which must reach the client as they are written.

With [Caddy](https://caddyserver.com/), which also obtains the certificate:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
```

With nginx:

```nginx
server {
  listen 443 ssl;
  server_name mcp.example.com;
  ssl_certificate     /etc/ssl/mcp.example.com.crt;
  ssl_certificate_key /etc/ssl/mcp.example.com.key;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 300s;
  }
}
```

If the proxy runs on the same machine, OAG-MCP can keep listening on
`127.0.0.1`, out of reach of everything else. Two settings still matter:

- `allowedHosts` is then required: on loopback, OAG-MCP accepts only
  `localhost` and loopback host names unless others are listed, so requests
  forwarded with `Host: mcp.example.com` would be refused.
- `mcpAuth` is still needed. OAG-MCP allows `mcpAuth.mode: none` on loopback,
  because only local processes can reach it, but the proxy makes it public.

## Connecting a client

Clients connect to the public URL with their token:

```json
{
  "mcpServers": {
    "my-api": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

## Health checks

`GET /healthz` answers `{"status":"ok"}` without authentication, but it is
subject to the same `Host` check as everything else. Probing OAG-MCP by its
IP address is refused when `allowedHosts` is set:

```text
$ curl -i http://10.0.0.5:3000/healthz
HTTP/1.1 403 Forbidden
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: 10.0.0.5"},"id":null}
```

Probe through the proxy, or send an allowed host name:

```bash
curl -H "Host: mcp.example.com" http://10.0.0.5:3000/healthz
```

In Kubernetes, set it in the probe:

```yaml
livenessProbe:
  httpGet:
    path: /healthz
    port: 3000
    httpHeaders:
      - name: Host
        value: mcp.example.com
```

## What the logs show

The examples below come from OAG-MCP listening on `0.0.0.0` with the
configuration above, called with `curl`. This `jq` command prints one line
per record:

```bash
tail -f oag-mcp.log | jq -r 'if .class_uid
  then "audit        \(.metadata.event_code) \(.actor.user.uid // .user.uid // "") \(.status_detail // "")"
  else "operational  \(.EventName)"
  end'
```

### At start-up

```text
operational  transport.remote_exposure
audit        authentication.mode_configured
operational  transport.initialized
operational  server.ready
```

`transport.remote_exposure` is a warning that OAG-MCP is reachable beyond
loopback, as a reminder that HTTPS must come from in front of it:

```json
{
  "SeverityText": "WARN",
  "EventName": "transport.remote_exposure",
  "Attributes": {
    "server.address": "0.0.0.0",
    "oag_mcp.note": "terminate HTTPS in a reverse proxy; oag-mcp serves plain HTTP"
  }
}
```

`transport.initialized` confirms the address, path and authentication mode:

```json
{
  "EventName": "transport.initialized",
  "Attributes": {
    "network.transport": "tcp",
    "network.protocol.name": "http",
    "server.address": "0.0.0.0",
    "server.port": 3000,
    "oag_mcp.path": "/mcp",
    "oag_mcp.mcp_auth_mode": "static-bearer",
    "oag_mcp.outcome": "success"
  }
}
```

### Requests that are refused

Every refusal is answered without reaching the MCP tools, and audited:

| Request | Response | Audit record |
| --- | --- | --- |
| No `Authorization` header | `401`, `WWW-Authenticate: Bearer realm="oag-mcp"` | `authentication.failed` (`missing_token`) |
| A token OAG-MCP does not know | `401`, `error="invalid_token"` | `authentication.failed` (`invalid_token`) |
| A `Host` not in `allowedHosts` | `403`, `Invalid Host: evil.example.net` | `transport.host_rejected` (`host_not_allowed`) |
| An `Origin` not in `allowedOrigins` | `403`, `Origin not allowed` | `transport.origin_rejected` (`origin_not_allowed`) |
| A token in the URL, `?access_token=…` | `400`, `Access tokens must be sent in the Authorization header` | `authentication.token_in_url_rejected` |

A request with a valid token, an allowed `Host` and either no `Origin` or an
allowed one gets `authentication.succeeded` naming the caller, and is served:

```text
audit        authentication.failed missing_token
audit        authentication.succeeded static:team-agent
audit        transport.host_rejected host_not_allowed
audit        transport.origin_rejected origin_not_allowed
audit        authentication.token_in_url_rejected
```

MCP clients that are not browsers send no `Origin`, so `allowedOrigins` only
matters for browser-based clients.

The [log events reference](../reference/log-events.md) describes every record,
and [Deployment](../deployment.md) covers temporary files and running in a
container.
