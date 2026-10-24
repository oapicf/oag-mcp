# Deployment

A deployment needs four things, all supplied at runtime:

| What | Notes |
| --- | --- |
| **oag-mcp** | `npm install -g oag-mcp` (Node.js 22+). Its `deno` dependency provides the sandbox runtime; alternatively set `OAG_MCP_DENO_PATH` or put Deno 2.x on `PATH`. |
| **The OpenAPI document** | `--spec`, read once at start-up. |
| **The typescript-fetch SDK** | `--sdk`, a directory or an `npm pack` archive, read once at start-up and never modified. Its runtime dependencies (if any) must already be installed. |
| **Configuration and secrets** | `--config` plus environment variables or a `0600` secrets file. |

The spec and SDK are prepared when the server starts, so deploying is a
matter of putting these inputs next to oag-mcp. Docker and OpenAPI
Generator are only needed where you generate the SDK, not on the server.

## Running

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

```dockerfile
FROM node:22-slim
RUN npm install -g oag-mcp@<version> && useradd --create-home --uid 10001 mcp
WORKDIR /srv
COPY openapi.yaml ./
COPY generated-sdk/ ./sdk/
COPY oag-mcp.config.yaml ./
USER mcp
ENV TMPDIR=/tmp
EXPOSE 3000
CMD ["oag-mcp", "serve", "--spec", "openapi.yaml", "--sdk", "sdk", \
     "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "3000", \
     "--config", "oag-mcp.config.yaml"]
```

If the SDK has runtime dependencies, install them in the image at build time
(`RUN cd sdk && npm install --omit=dev --ignore-scripts`); oag-mcp will not
install them when it starts.

Binding `0.0.0.0` requires `mcpAuth.mode: static-bearer` or `oauth`. Supply
secrets as environment variables or a mounted secrets file
(`chmod 600`). Put a TLS-terminating reverse proxy in front and set
`http.publicUrl` and `http.allowedHosts`:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Recommended hardening: run as a non-root user, read-only root filesystem
with a writable `TMPDIR`, drop capabilities, container memory/CPU limits in
addition to `execution.memoryMb`.

## Publishing oag-mcp

The package is npm-compatible (`npm pack`, `npm publish`). `prepare` builds
`dist/` from TypeScript. Nothing is published without explicit
authorisation; releases use the existing `make release-*` / GitHub
workflows.
