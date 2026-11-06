# Deployment

A deployment needs four things, all supplied when the server starts:

| What | Notes |
| --- | --- |
| **OAG-MCP** | `npm install -g oag-mcp` (Node.js 22+). Its `deno` dependency provides the sandbox runtime; alternatively set `OAG_MCP_DENO_PATH` or put Deno 2.5 or later (2.x) on `PATH`. |
| **The OpenAPI document** | `--spec`, read once at start-up. |
| **The typescript-fetch SDK** | `--sdk`, a directory or an `npm pack` archive, read once at start-up and never modified. Its runtime dependencies (if any) must already be installed. |
| **Configuration and secrets** | `--config` plus environment variables or a `0600` secrets file. |

The spec and SDK are prepared when the server starts, so deploying is a
matter of putting these inputs next to OAG-MCP. Docker and OpenAPI
Generator are only needed where you generate the SDK, not on the server.

## Running

How OAG-MCP runs depends on the transport:

- **stdio** is not deployed as such. The MCP client starts `oag-mcp serve`
  as a subprocess on the user's own machine, from its MCP server settings,
  and stops it when the client closes. "Deploying" means installing
  OAG-MCP there and giving the client the command, its inputs and the
  secrets it needs.
- **Streamable HTTP** is a long-running server that remote MCP clients
  connect to. This is what the rest of this page is about.

```bash
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio \
  --config ./oag-mcp.config.yaml

oag-mcp serve --spec ./openapi.yaml --sdk ./petstore-sdk-1.0.0.tgz \
  --transport streamable-http --port 3000 --config ./oag-mcp.config.yaml
```

Start-up prepares the SDK before the transport opens; readiness is the
`server.ready` log record (and, for HTTP, `oag-mcp listening on <url>` on
stderr and `GET /healthz`). A non-zero exit during start-up means nothing
was served; the stderr message carries an error code and a hint.

**After changing the spec or the SDK, restart the process.** The index and
bindings are fixed for its lifetime.

## Temporary files

Each process prepares into a private `oag-mcp-ws-*` directory under the OS
temporary directory (`TMPDIR`), typically a few megabytes: the sandbox
bundle, declarations and, for archives, the extracted package. It contains
no secrets. It is removed on graceful shutdown (`SIGINT`, `SIGTERM`, stdio
client disconnect) and on start-up failure; after an unclean exit the next
start on the same host removes it. Each execution also uses a short-lived
private temporary directory for the Deno sandbox.

On a read-only root filesystem, mount a writable `tmpfs` and point `TMPDIR`
at it.

## Container example

This image serves a packaged SDK over Streamable HTTP, behind a
TLS-terminating proxy at `https://mcp.example.com`:

```dockerfile
FROM node:22-slim
RUN npm install -g oag-mcp@<version> \
  && useradd --create-home --uid 10001 mcp \
  && mkdir -p /var/log/oag-mcp && chown mcp /var/log/oag-mcp
WORKDIR /srv
COPY openapi.yaml oag-mcp.config.yaml petstore-sdk-1.0.0.tgz ./
USER mcp
ENV TMPDIR=/tmp
VOLUME /var/log/oag-mcp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD ["node", "-e", "require('http').get({host: '127.0.0.1', port: 3000, path: '/healthz', headers: {host: 'mcp.example.com'}}, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
CMD ["oag-mcp", "serve", "--spec", "openapi.yaml", "--sdk", "petstore-sdk-1.0.0.tgz", \
     "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "3000", \
     "--config", "oag-mcp.config.yaml", "--audit-log-file", "/var/log/oag-mcp/audit.log"]
```

with this `oag-mcp.config.yaml`:

```yaml
upstream:
  baseUrl: https://api.example.com/v1
upstreamAuth:
  schemes:
    apiKeyHeader:
      apiKey: { env: PETSTORE_API_KEY }
mcpAuth:
  mode: oauth
  oauth:
    issuer: https://auth.example.com
    requiredScopes: [mcp:tools]
authorization:
  default: deny
  rules:
    - id: read-only
      allow: [method:GET]
http:
  publicUrl: https://mcp.example.com/mcp
  allowedHosts: [mcp.example.com]
logging:
  auditFailClosed: true
```

Pass `PETSTORE_API_KEY` from your secret manager when the container starts;
it is not in the image. Operational records go to stderr, where the
container platform collects them, and audit records to their own file on the
volume. The health check sends the public `Host`, because `/healthz` is
subject to the `Host` check like every other path.

If the SDK has runtime dependencies, install them in the image at build time
(`RUN cd sdk && npm install --omit=dev --ignore-scripts` for an SDK
directory); OAG-MCP will not install them when it starts.

In front of it, any TLS-terminating proxy will do; with Caddy:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Run the container as configured above, with a read-only root filesystem, a
`tmpfs` at `/tmp`, all capabilities dropped and memory and CPU limits.
[Deploying to production](#deploying-to-production) explains each of these.

## Deploying to production

A production server is one that callers other than you depend on, usually
reached over Streamable HTTP. Before it goes live, prepare each of the
following. The [recipes](recipes/README.md) under "Running in production"
show the main pieces in full.

### Fixed inputs

- **Pin every version**: OAG-MCP (`oag-mcp@<version>`, not `latest`), the
  OpenAPI document, and the SDK. Ship the SDK as a versioned `npm pack`
  archive built in your pipeline, so every server runs exactly the same
  code; see the [packaged SDK recipe](recipes/packaged-sdk.md).
- **Install the SDK's runtime dependencies at build time.** OAG-MCP will not
  install them, and refuses to start without them.
- **Start each new version once in your pipeline**, with the production
  configuration and placeholder secrets. Preparation checks the spec, the SDK
  and their match before anything is served, so a bad input fails the build
  rather than the deployment.

### Who may call it

- **Authenticate every caller** with `mcpAuth.mode: static-bearer` or
  `oauth`. OAG-MCP refuses `none` on a non-loopback address. Prefer `oauth`
  when callers can sign in through your identity provider; use
  `mcpAuth.oauth.requiredScopes` to keep tokens issued for other services
  out. See [Authentication](authentication.md#mcp-auth).
- **Write an authorisation policy** with `default: deny`. Without one, every
  caller may call every operation, and the start-up audit record says
  `policyMode: implicit-allow-all`. Start from the
  [read-only recipe](recipes/read-only.md), and add write operations only
  for the callers that need them; see [Authorisation](authorisation.md).

### Credentials for the API

- **Give OAG-MCP its own API credentials**, with only the permissions its
  callers should ever have. Every caller reaches the API as this one
  identity, so it is the ceiling on what any agent can do.
- **Supply secrets from your secret manager**, as environment variables or a
  mounted secrets file with `0600` permissions. Never put them in the
  configuration file, the image or the command line.
- **Plan for rotation.** Secrets are read at start-up, so a rotated
  credential takes effect when the server restarts. OAuth2 tokens obtained
  from a token endpoint renew themselves.

### Network

- **Terminate TLS in a reverse proxy** or load balancer, and keep OAG-MCP's
  own port reachable only from it. OAG-MCP serves plain HTTP.
- **Set `http.publicUrl`** to the external `https://` URL, which is also the
  OAuth resource identifier, and **`http.allowedHosts`** to the names
  clients use. On a non-loopback address no `Host` check is made without it.
  Set `http.allowedOrigins` only if browser-based clients must connect.
- **Limit outbound traffic**, if your platform can, to the API's base URL,
  the OAuth2 token endpoint and, for `oauth`, the authorization server's keys
  or introspection endpoint. The sandbox needs no network of its own.
- **Health checks** call `GET /healthz`, which needs no authentication but
  is subject to the `Host` check: send an allowed `Host`, such as the public
  name.

The [remote server recipe](recipes/remote-server.md) and the
[HTTP endpoints reference](reference/http-endpoints.md) cover all of these.

### Capacity and limits

- **Size memory** for `execution.maxConcurrent` sandboxes of
  `execution.memoryMb` each, plus OAG-MCP itself and the prepared SDK.
  Calls beyond `maxConcurrent` wait in a queue of `execution.maxQueue`, and
  beyond that are refused with `executor_busy`.
- **Set container CPU and memory limits** as well: OAG-MCP's time limit is
  the only bound on CPU.
- **Tune the execution limits** (time, SDK calls, result size) to your
  workload; see the [execution limits recipe](recipes/execution-limits.md).
- **Scale out by adding servers.** Requests are served without sessions, so
  any server can answer any request, and a load balancer needs no sticky
  sessions. Each server has its own limits and its own OAuth2 token cache.

### The process

- Run as a **non-root user**, with a **read-only root filesystem**, a
  writable `tmpfs` for `TMPDIR`, and all Linux capabilities dropped.
- **Stop it with `SIGTERM`**. OAG-MCP closes its connections and removes its
  workspace. It does not wait for calls in progress, so take a server out of
  the load balancer before stopping it. Do not send `SIGHUP`: OAG-MCP does
  not handle it, and exits at once without cleaning up.
- **Restart to change anything**: the spec, the SDK, the configuration or a
  secret. Rolling restarts behind a load balancer avoid downtime.
- **Keep Deno updated.** The sandbox's security depends on it; take OAG-MCP
  releases that update its `deno` dependency. See
  [Security](security.md#what-is-not-claimed).

### Logs and monitoring

- **Send security audit records to their own destination**, and from there
  to an append-only store or SIEM; local files are not tamper-proof. See the
  [audit logging recipe](recipes/audit-logging.md).
- **Decide on fail-closed auditing.** With `--audit-fail-closed`, `execute`
  stops while audit records cannot be written; choose it where an unaudited
  API call is worse than an outage.
- **Rotate log files** by copying and truncating, if you write to files at
  all; OAG-MCP never reopens them.
- **Alert on** refused start-ups, `authentication.failed`,
  `authorization.denied` and `execution.boundary_violation`; the audit
  logging recipe lists what to watch.
- **Use `server.ready`** as the readiness signal, and the
  [log events reference](reference/log-events.md) to build dashboards.

### Before going live

Start the server with its production configuration and check:

1. the start-up audit records show what you intended:
   `authentication.mode_configured` with your mode,
   `authorization.policy_loaded` with `policyMode: configured`, and
   `credential.provider.configured` with the schemes you set up;
2. a request without a token is refused with `401`, and one with a bad
   `Host` with `403`;
3. an allowed call succeeds, and a denied one is refused and recorded as
   `authorization.denied`;
4. the audit records arrive where they should.
