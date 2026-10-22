# Packaging and deployment

## The artifact

```text
my-mcp-server/
├── oag-mcp-manifest.json   target, versions, options, input hashes, file hashes
├── package.json            private package pinning the oag-mcp runtime version
├── README.md
├── index/
│   ├── methods.json        method records (search results)
│   └── search-index.json   serialised MiniSearch index
├── sdk/
│   ├── sdk.bundle.js       prepared SDK (one ES module, dependencies inlined)
│   ├── sdk-binding.d.ts    declaration of the `sdk` binding
│   ├── types/              SDK declarations
│   └── ts-lib/             TypeScript lib files for type checking
├── executor/runner.js      Deno sandbox runner
└── sdk-package/            generated SDK package (--generate-sdk only)
```

The artifact contains no secrets and does not need the original spec or SDK,
Java, Docker, or per-request package installation. On start-up every file is
verified against the manifest's SHA-256 hashes (`ARTIFACT_INTEGRITY` on
mismatch); rebuild rather than editing files.

Runtime prerequisites that are not bundled: **Node.js 22+**, the
**oag-mcp** runtime (global install or `npm install` in the artifact), and
**Deno 2.x** (installed with oag-mcp's `deno` dependency, or provided via
`OAG_MCP_DENO_PATH`/`PATH`).

## Running

```bash
# global CLI
npm install -g oag-mcp
oag-mcp serve ./my-mcp-server --transport streamable-http --config ./oag-mcp.config.yaml

# or pin the runtime next to the artifact (one-time install)
cd my-mcp-server && npm install --omit=dev && npx oag-mcp serve . --transport stdio
```

## Container example

```dockerfile
FROM node:22-slim
RUN useradd --create-home --uid 10001 mcp
WORKDIR /srv
COPY my-mcp-server/ ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY oag-mcp.config.yaml ./
USER mcp
EXPOSE 3000
CMD ["npx", "--prefix", "server", "oag-mcp", "serve", "server", \
     "--transport", "streamable-http", "--host", "0.0.0.0", "--port", "3000", \
     "--config", "oag-mcp.config.yaml"]
```

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
(the executor only writes to the OS temp directory), drop capabilities,
container memory/CPU limits in addition to `execution.memoryMb`.

## Publishing oag-mcp

The package is npm-compatible (`npm pack`, `npm publish`). `prepare` builds
`dist/` from TypeScript. Nothing is published without explicit
authorisation; releases use the existing `make release-*` / GitHub
workflows.
