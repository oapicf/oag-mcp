# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed
- Replace PC_ with TEST_PETCLINIC_ prefix to avoid confusion

### Fixed
- Set all four annotation hints on the search and execute tools

## 0.10.2 - 2026-11-07
### Fixed
- Improve documentation consistency and correctness
- Fix slow path matching in the request broker on long request paths
- Fix slow trailing-slash trimming of URLs and path templates
- Fix guessable OAuth principal ids by keying them with mcpAuth.oauth.principalIdKey

## 0.10.1 - 2026-11-05
### Fixed
- Fix publish workflow to use make deps-upgrade
- Upgrade dependencies to latest (except TS, waiting for TS7 API to stabilise)

## 0.10.0 - 2026-11-03
### Added
- `oag-mcp serve --spec <openapi> --sdk <typescript-fetch SDK dir|.tgz>` over stdio and Streamable HTTP, exposing exactly two MCP tools, `search` and `execute`
- Start-up preparation, once per process and logged per stage: input validation, SDK compatibility checks (OpenAPI Generator 7.26.0, options, source or compiled layout, installed dependencies), safe archive extraction, an esbuild-prepared execution bundle, static method-to-operation binding analysis and an in-memory MiniSearch index
- Private, self-cleaning preparation workspace (removed on shutdown, start-up failure and stale-process sweep); the supplied SDK is never modified and no packages are installed
- Deno subprocess executor with no permissions, string code generation disabled, timeouts, memory/output limits and a host-side request broker
- MCP access control: none (loopback only), static bearer and OAuth resource server (JWKS or introspection, RFC 9728 metadata)
- Upstream authentication: apiKey (header/query), HTTP Basic, HTTP Bearer and OAuth2 client credentials with token caching and renewal
- Per-operation authorization policy enforced in search and on every SDK call
- Structured logging in two open standards: operational records as OpenTelemetry log records (semantic conventions 1.44.0, including the MCP conventions) and security audit records as OCSF 1.9.0 events, with redaction and fail-closed auditing; one audit decision record per attempted SDK operation

### Changed
- Convert the generator-node template to TypeScript (tsc, tsx, typescript-eslint) while keeping bagofcli and Mocha/Sinon/referee
- Replace the Suntory/Bob pipeline with Olympia: Makefile targets that run the project's own tools (tsc, Prettier, ESLint, Mocha, c8, TypeDoc, npm pack)
