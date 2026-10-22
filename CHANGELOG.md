# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
### Added
- `oag-mcp build` for existing typescript-fetch SDKs (package directory or npm package archive) and for SDKs generated locally with OpenAPI Generator 7.25.0/7.26.0 (Java or Docker backend)
- SDK compatibility checks, safe archive extraction, static method-to-operation binding analysis and an esbuild-prepared execution bundle
- Self-contained build artifact with method index, MiniSearch full-text index, SDK declarations, Deno runner and a manifest with versions, options and input/file hashes
- `oag-mcp serve` over stdio and Streamable HTTP exposing exactly two MCP tools, `search` and `execute`
- Deno subprocess executor with no permissions, string code generation disabled, timeouts, memory/output limits and a host-side request broker
- MCP access control: none (loopback only), static bearer and OAuth resource server (JWKS or introspection, RFC 9728 metadata)
- Upstream authentication: apiKey (header/query), HTTP Basic, HTTP Bearer and OAuth2 client credentials with token caching and renewal
- Per-operation authorization policy enforced in search and on every SDK call
- Pino structured logging with separate operational and security_audit categories, redaction and fail-closed auditing

### Changed
- Convert the generator-node template to TypeScript (tsc, tsx, typescript-eslint) while keeping bagofcli, Mocha/Sinon/referee and the Suntory/Bob pipeline
