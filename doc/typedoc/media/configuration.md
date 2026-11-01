# Configuration reference

The configuration file, passed with
`oag-mcp serve --spec <openapi> --sdk <sdk> --config <file>`, sets
everything the [CLI flags](cli.md) don't: where upstream calls go and their
limits, the upstream API's credentials (`upstreamAuth`), who may call the MCP
server (`mcpAuth`), which operations each caller may use (`authorization`),
sandbox limits (`execution`), the Streamable HTTP endpoint (`http`) and logging
(`logging`).

The file is YAML or JSON. Every section and property is optional, and anything
left out takes its default; without `--config`, oag-mcp runs on the defaults
alone. Unknown properties are rejected, to catch typos. The file is read and
validated once at start-up, and an invalid file stops oag-mcp with a
`CONFIG_INVALID` error naming the property; restart oag-mcp to apply changes.
`--host`, `--port`, `--path` and the logging flags override the matching
properties here.

The file never contains secret values. Each property that takes a secret holds
a *secret reference* instead, in one of two forms:

```yaml
{ env: NAME }      # the value of environment variable NAME
{ secret: key }    # the value of key in the upstreamAuth.secretsFile map
```

References are resolved when oag-mcp starts, so a missing variable or key
stops it with a configuration error.

## Example

This example sets every property, to show its shape. A real file sets only
what it needs; [examples/oag-mcp.config.yaml](../../examples/oag-mcp.config.yaml)
is a working one for the Pet Clinic test fixture.

```yaml
upstream:
  baseUrl: https://api.example.com/v1
  allowedOrigins: [https://files.example.com]
  followRedirects: true
  maxRedirects: 3
  timeoutMs: 15000
  maxResponseBytes: 5242880
  maxRequestBytes: 1048576

upstreamAuth:
  provider: service-identity
  secretsFile: ./secrets.yaml
  allowInsecureTokenUrl: false
  schemes:
    apiKeyHeader:
      apiKey: { env: API_KEY }
    adminBasic:
      username: { env: ADMIN_USER }
      password: { secret: admin_password }
    bearerAuth:
      token: { env: API_TOKEN }
    clinicOAuth:
      clientId: { env: CLIENT_ID }
      clientSecret: { env: CLIENT_SECRET }
      tokenUrl: https://auth.example.com/oauth/token
      scopes: [pets:write]
      audience: https://api.example.com
      clientAuthMethod: client_secret_basic

mcpAuth:
  mode: oauth
  stdio:
    principal: local
    scopes: []
  staticBearer:
    tokens:
      - principal: ci-bot
        token: { env: OAG_MCP_TOKEN_CI }
        scopes: [pets:read]
  oauth:
    issuer: https://auth.example.com/
    jwksUri: https://auth.example.com/.well-known/jwks.json
    audience: [https://mcp.example.com/mcp]
    resource: https://mcp.example.com/mcp
    requiredScopes: [mcp:tools]
    scopesSupported: [mcp:tools, pets:read, pets:write]
    algorithms: [RS256, PS256, ES256, EdDSA]
    clockToleranceSec: 30
    introspection:
      endpoint: https://auth.example.com/oauth/introspect
      clientId: { env: INTROSPECTION_CLIENT_ID }
      clientSecret: { env: INTROSPECTION_CLIENT_SECRET }
    allowInsecureIssuer: false

authorization:
  default: deny
  rules:
    - id: readers
      scopes: [pets:read]
      allow: ["method:GET"]
      deny: ["AdminApi.*"]
    - id: ci
      principals: [ci-bot]
      allow: ["PetsApi.*", "tag:owners"]
    - id: app
      clientIds: [my-oauth-client]
      allow: ["*"]

execution:
  timeoutMs: 30000
  maxTimeoutMs: 120000
  memoryMb: 256
  maxConcurrent: 4
  maxQueue: 16
  maxSdkCalls: 200
  maxResultBytes: 65536
  maxLogBytes: 16384
  maxCodeBytes: 100000
  typecheck: true
  denoPath: /usr/local/bin/deno

http:
  host: 127.0.0.1
  port: 3000
  path: /mcp
  publicUrl: https://mcp.example.com/mcp
  allowedHosts: [mcp.example.com]
  allowedOrigins: [https://app.example.com]
  maxBodyBytes: 1048576

logging:
  level: info
  format: json
  file: /var/log/oag-mcp/operational.log
  auditFile: /var/log/oag-mcp/audit.log
  auditFailClosed: false
```

## Properties

Names use dot notation. `<scheme>` stands for an OpenAPI security scheme name
used as a key, and `[]` marks the properties of each item in a list, so
`mcpAuth.staticBearer.tokens[].principal` is the `principal` of each token.
"Secret reference" is `{ env: NAME }` or `{ secret: key }`, as described above.

| Name | Description | Type | Mandatory | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `upstream.baseUrl` | Base URL that SDK calls are sent to, in place of the OpenAPI document's servers. Must be absolute http or https. | string (URL) | Yes, when the OpenAPI document's first server URL is missing or not absolute | The OpenAPI document's first server URL | `https://api.example.com/v1` |
| `upstream.allowedOrigins` | Origins that upstream redirects may go to, besides the base URL's own origin. Credentials are never sent to them. | string[] (URLs) | No | `[]` | `[https://files.example.com]` |
| `upstream.followRedirects` | Whether to follow upstream redirects, to allowed origins only. | boolean | No | `true` | `false` |
| `upstream.maxRedirects` | The most redirects followed for one SDK call. | integer, 0 to 10 | No | `3` | `5` |
| `upstream.timeoutMs` | Time limit for each upstream call, in milliseconds. | integer, 100 to 300000 | No | `15000` | `30000` |
| `upstream.maxResponseBytes` | The largest upstream response body accepted, in bytes. | integer, at least 1024 | No | `5242880` (5 MiB) | `10485760` |
| `upstream.maxRequestBytes` | The largest request body sent upstream, in bytes. | integer, at least 1024 | No | `1048576` (1 MiB) | `2097152` |
| `upstreamAuth.provider` | Where upstream credentials come from. `service-identity`, the only provider, uses the one set of credentials configured here for every MCP caller. | string | No | `service-identity` | `service-identity` |
| `upstreamAuth.secretsFile` | A YAML or JSON map of secret values for `{ secret: key }` references. A relative path is resolved from the configuration file's directory. The file must not be readable by group or others (`chmod 600`). | string (path) | Yes, when any `{ secret: key }` reference is used | None | `./secrets.yaml` |
| `upstreamAuth.allowInsecureTokenUrl` | Allow plain http OAuth2 token URLs on non-loopback hosts, which would expose client secrets. Loopback token URLs are always allowed. For local testing only. | boolean | No | `false` | `true` |
| `upstreamAuth.schemes.<scheme>.apiKey` | The key for an `apiKey` security scheme, sent where the scheme says (header, query or cookie). | secret reference | Yes, for an `apiKey` scheme | None | `{ env: API_KEY }` |
| `upstreamAuth.schemes.<scheme>.username` | The user name for an http `basic` scheme. | secret reference | Yes, for a `basic` scheme | None | `{ env: ADMIN_USER }` |
| `upstreamAuth.schemes.<scheme>.password` | The password for an http `basic` scheme. | secret reference | Yes, for a `basic` scheme | None | `{ secret: admin_password }` |
| `upstreamAuth.schemes.<scheme>.token` | The token for an http `bearer` scheme. | secret reference | Yes, for a `bearer` scheme | None | `{ env: API_TOKEN }` |
| `upstreamAuth.schemes.<scheme>.clientId` | The client id for an `oauth2` scheme's client credentials flow. | secret reference | Yes, for an `oauth2` scheme | None | `{ env: CLIENT_ID }` |
| `upstreamAuth.schemes.<scheme>.clientSecret` | The client secret for an `oauth2` scheme's client credentials flow. | secret reference | Yes, for an `oauth2` scheme | None | `{ env: CLIENT_SECRET }` |
| `upstreamAuth.schemes.<scheme>.tokenUrl` | The token endpoint for an `oauth2` scheme. Must be https or loopback, unless `allowInsecureTokenUrl` is set. | string (URL) | No | The scheme's `clientCredentials.tokenUrl` in the OpenAPI document | `https://auth.example.com/oauth/token` |
| `upstreamAuth.schemes.<scheme>.scopes` | The scopes requested for an `oauth2` token. | string[] | No | The scopes the called operation requires | `[pets:write]` |
| `upstreamAuth.schemes.<scheme>.audience` | An `audience` parameter added to the token request, for authorization servers that need one. | string | No | None | `https://api.example.com` |
| `upstreamAuth.schemes.<scheme>.clientAuthMethod` | How the client id and secret are sent to the token endpoint: an HTTP Basic header, or form fields in the request body. | string | No | `client_secret_basic` | `client_secret_basic`, `client_secret_post` |
| `mcpAuth.mode` | How Streamable HTTP callers are authenticated: not at all, with configured bearer tokens, or as an OAuth 2.0 resource server. `none` is refused on a non-loopback `http.host`. Has no effect on stdio. | string | No | `none` | `none`, `static-bearer`, `oauth` |
| `mcpAuth.stdio.principal` | The principal name given to stdio sessions, for `authorization` rules and audit records. | string | No | `local` | `local`, `desktop-user` |
| `mcpAuth.stdio.scopes` | The scopes given to stdio sessions, for `authorization` rules. | string[] | No | `[]` | `[pets:read]` |
| `mcpAuth.staticBearer.tokens[].principal` | The principal a token authenticates as. | string | Yes, for each token | None | `ci-bot` |
| `mcpAuth.staticBearer.tokens[].token` | The bearer token callers present. | secret reference | Yes, for each token; at least one token when `mcpAuth.mode` is `static-bearer` | None | `{ env: OAG_MCP_TOKEN_CI }` |
| `mcpAuth.staticBearer.tokens[].scopes` | The scopes the token grants, for `authorization` rules. | string[] | No | `[]` | `[pets:read]` |
| `mcpAuth.oauth.issuer` | The authorization server's issuer, which tokens must name. Must be https or loopback, unless `allowInsecureIssuer` is set. | string (URL) | Yes, when `mcpAuth.mode` is `oauth` | None | `https://auth.example.com/` |
| `mcpAuth.oauth.jwksUri` | Where the keys that sign JWT access tokens are published. Not used with `introspection`. | string (URL) | No | Discovered from the issuer's metadata | `https://auth.example.com/.well-known/jwks.json` |
| `mcpAuth.oauth.audience` | The audiences a token must be issued for. | string[] | No | The `resource` URL alone | `[https://mcp.example.com/mcp]` |
| `mcpAuth.oauth.resource` | This server's resource identifier, published in its protected resource metadata (RFC 9728). | string (URL) | No | `http.publicUrl`, or the local endpoint URL | `https://mcp.example.com/mcp` |
| `mcpAuth.oauth.requiredScopes` | Scopes every token must carry. | string[] | No | `[]` | `[mcp:tools]` |
| `mcpAuth.oauth.scopesSupported` | The scopes advertised in the protected resource metadata. | string[] | No | `requiredScopes` | `[mcp:tools, pets:read]` |
| `mcpAuth.oauth.algorithms` | The JWT signing algorithms accepted. | string[] | No | `[RS256, PS256, ES256, EdDSA]` | `[RS256]` |
| `mcpAuth.oauth.clockToleranceSec` | Clock skew allowed when checking token times, in seconds. | integer, 0 to 300 | No | `30` | `60` |
| `mcpAuth.oauth.introspection.endpoint` | An RFC 7662 introspection endpoint, for opaque (non-JWT) tokens. When set, it replaces JWT validation. | string (URL) | Yes, when `introspection` is set | None | `https://auth.example.com/oauth/introspect` |
| `mcpAuth.oauth.introspection.clientId` | The client id oag-mcp authenticates to the introspection endpoint with. | secret reference | Yes, when `introspection` is set | None | `{ env: INTROSPECTION_CLIENT_ID }` |
| `mcpAuth.oauth.introspection.clientSecret` | The client secret for the introspection endpoint. | secret reference | Yes, when `introspection` is set | None | `{ env: INTROSPECTION_CLIENT_SECRET }` |
| `mcpAuth.oauth.allowInsecureIssuer` | Allow a plain http issuer on a non-loopback host. For local testing only. | boolean | No | `false` | `true` |
| `authorization.default` | The decision for an operation no rule allows or denies. Without an `authorization` section at all, every operation is allowed. | string | No | `deny` | `deny`, `allow` |
| `authorization.rules[].id` | The rule's name, recorded in audit records. | string | Yes, for each rule | None | `readers` |
| `authorization.rules[].principals` | The rule applies only to these principals, by name or id; `*` wildcards allowed. | string[] | No | Any principal | `[ci-bot, "team-*"]` |
| `authorization.rules[].scopes` | The rule applies only to callers holding all of these scopes. | string[] | No | Any scopes | `[pets:read]` |
| `authorization.rules[].clientIds` | The rule applies only to callers with one of these OAuth client ids. | string[] | No | Any client | `[my-oauth-client]` |
| `authorization.rules[].allow` | Operations the rule allows, as patterns: `PetsApi.listPets` or a glob such as `PetsApi.*`, `tag:<tag>`, `method:<METHOD>` or `operationId:<glob>`. | string[] | No | `[]` | `["method:GET"]`, `["PetsApi.*", "tag:owners"]` |
| `authorization.rules[].deny` | Operations the rule denies, in the same patterns as `allow`. A deny from any applicable rule wins over every allow. | string[] | No | `[]` | `["AdminApi.*"]` |
| `execution.timeoutMs` | Time limit for each `execute` call, in milliseconds, when the call doesn't set its own. | integer, at least 100 | No | `30000` | `60000` |
| `execution.maxTimeoutMs` | The highest time limit an `execute` call may ask for, in milliseconds. | integer, at least 100 | No | `120000` | `300000` |
| `execution.memoryMb` | Memory (V8 heap) limit of each sandbox, in MB. | integer, 32 to 4096 | No | `256` | `512` |
| `execution.maxConcurrent` | The most `execute` calls running at once. | integer, 1 to 64 | No | `4` | `8` |
| `execution.maxQueue` | The most `execute` calls waiting for a free slot; beyond that, calls are refused. | integer, 0 to 1000 | No | `16` | `32` |
| `execution.maxSdkCalls` | The most SDK calls one `execute` call may make. | integer, at least 1 | No | `200` | `500` |
| `execution.maxResultBytes` | The largest result an `execute` call may return, in bytes. | integer, at least 256 | No | `65536` | `262144` |
| `execution.maxLogBytes` | The most console output kept from one `execute` call, in bytes. | integer, at least 0 | No | `16384` | `65536` |
| `execution.maxCodeBytes` | The largest code an `execute` call may submit, in bytes. | integer, at least 256 | No | `100000` | `200000` |
| `execution.typecheck` | Type-check submitted code against the SDK's types before running it, and return type errors to the agent. | boolean | No | `true` | `false` |
| `execution.denoPath` | The Deno binary that runs the sandbox. A relative path is resolved from the working directory. | string (path) | No | `OAG_MCP_DENO_PATH`, then the `deno` npm dependency, then `deno` on `PATH` | `/usr/local/bin/deno` |
| `http.host` | The address Streamable HTTP binds to. A non-loopback address needs `mcpAuth.mode` `static-bearer` or `oauth`. Overridden by `--host`. | string | No | `127.0.0.1` | `127.0.0.1`, `0.0.0.0` |
| `http.port` | The port Streamable HTTP listens on; `0` picks a free port. Overridden by `--port`. | integer, 0 to 65535 | No | `3000` | `3000`, `8080` |
| `http.path` | The URL path of the MCP endpoint. Overridden by `--path`. | string, starting with `/` | No | `/mcp` | `/mcp` |
| `http.publicUrl` | The endpoint's URL as clients see it, for example behind a TLS-terminating proxy. Used as the OAuth resource. | string (URL) | No | The local endpoint URL | `https://mcp.example.com/mcp` |
| `http.allowedHosts` | Host names accepted in the `Host` header, compared without the port, against DNS rebinding. Loopback binds also accept `localhost` and loopback addresses. | string[] | No | `[]` | `[mcp.example.com]` |
| `http.allowedOrigins` | Browser origins accepted in the `Origin` header, compared exactly (scheme, host and port). With none set, loopback binds accept localhost origins and other binds accept none. Requests without an `Origin` header are unaffected. | string[] (origins) | No | `[]` | `[https://app.example.com]` |
| `http.maxBodyBytes` | The largest MCP request body accepted, in bytes. | integer, at least 1024 | No | `1048576` (1 MiB) | `2097152` |
| `logging.level` | The level of operational (OpenTelemetry) records. Security audit records are written whatever the level. Overridden by `--log-level`. | string | No | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `logging.format` | `json` writes one record per line; `pretty` writes readable lines for local development, and applies only to stderr. Overridden by `--log-format`. | string | No | `json` | `json`, `pretty` |
| `logging.file` | Where operational records go: a file path, relative to the working directory, or `fd:N` for an open file descriptor. stdout is refused. Overridden by `--log-file`. | string | No | stderr | `/var/log/oag-mcp/operational.log`, `fd:3` |
| `logging.auditFile` | Where security audit (OCSF) records go: a file path or `fd:N`. stdout is refused. Overridden by `--audit-log-file`. | string | No | stderr | `/var/log/oag-mcp/audit.log`, `fd:4` |
| `logging.auditFailClosed` | Refuse `execute` calls while security audit records cannot be written. `--audit-fail-closed` also turns it on. | boolean | No | `false` | `true` |
