# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
### Added
- `oag-mcp serve --spec <openapi> --sdk <typescript-fetch SDK dir|.tgz>` over stdio and Streamable HTTP, exposing exactly two MCP tools, `search` and `execute`
- Start-up preparation, once per process and logged per stage: input validation, SDK compatibility checks (OpenAPI Generator 7.25.0/7.26.0, options, source or compiled layout, installed dependencies), safe archive extraction, an esbuild-prepared execution bundle, static method-to-operation binding analysis and an in-memory MiniSearch index
- Private, self-cleaning preparation workspace (removed on shutdown, start-up failure and stale-process sweep); the supplied SDK is never modified and no packages are installed
- Deno subprocess executor with no permissions, string code generation disabled, timeouts, memory/output limits and a host-side request broker
- MCP access control: none (loopback only), static bearer and OAuth resource server (JWKS or introspection, RFC 9728 metadata)
- Upstream authentication: apiKey (header/query), HTTP Basic, HTTP Bearer and OAuth2 client credentials with token caching and renewal
- Per-operation authorization policy enforced in search and on every SDK call
- Pino structured logging with separate operational and security_audit categories, redaction and fail-closed auditing

### Removed
- The `oag-mcp build` command, prepared artifact directories and `serve <artifact-dir>`; SDK generation (`--generate-sdk`, Java/Docker backends) and automatic `npm install` of SDK dependencies. See "Migrating from `oag-mcp build`" in the README.

### Changed
- Convert the generator-node template to TypeScript (tsc, tsx, typescript-eslint) while keeping bagofcli, Mocha/Sinon/referee and the Suntory/Bob pipeline
