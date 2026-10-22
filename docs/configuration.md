# Configuration reference

`oag-mcp serve <artifact> --config <file>` reads a YAML or JSON file. Every
section is optional; unknown keys are rejected to catch typos. CLI flags
(`--host`, `--port`, `--path`, logging flags) override the file.

**Secrets are never written in this file.** Every secret is a reference:

```yaml
{ env: NAME }      # environment variable of the oag-mcp process
{ secret: key }    # key in upstreamAuth.secretsFile (YAML/JSON map, chmod 600)
```

Secrets are not accepted as CLI arguments and are never stored in artifacts.

## Full example

```yaml
upstream:
  baseUrl: https://api.example.com/v1     # default: first OpenAPI server URL
  allowedOrigins: []                      # extra redirect targets (credentials never forwarded)
  followRedirects: true
  maxRedirects: 3
  timeoutMs: 15000                        # per upstream call
  maxResponseBytes: 5242880
  maxRequestBytes: 1048576

upstreamAuth:                             # credentials for calls to YOUR API
  provider: service-identity              # one shared upstream identity (v1)
  secretsFile: ./secrets.yaml             # optional, must not be group/world readable
  allowInsecureTokenUrl: false            # allow http:// token URLs (local testing only)
  schemes:                                # keys are OpenAPI security scheme names
    apiKeyHeader:   { apiKey: { env: API_KEY } }                 # apiKey in header
    apiKeyQuery:    { apiKey: { env: API_KEY } }                 # apiKey in query
    adminBasic:     { username: { env: ADMIN_USER }, password: { secret: admin_password } }
    bearerAuth:     { token: { env: API_TOKEN } }
    clinicOAuth:                                                 # oauth2 clientCredentials
      clientId: { env: CLIENT_ID }
      clientSecret: { env: CLIENT_SECRET }
      tokenUrl: https://auth.example.com/oauth/token             # default: from the spec
      scopes: [pets:write]                                       # default: operation's scopes
      audience: https://api.example.com                          # optional
      clientAuthMethod: client_secret_basic                      # or client_secret_post

mcpAuth:                                  # access control for callers of THIS server
  mode: none                              # none | static-bearer | oauth (HTTP only)
  stdio:
    principal: local                      # principal name for stdio sessions
    scopes: []
  staticBearer:
    tokens:
      - { principal: ci-bot, token: { env: OAG_MCP_TOKEN_CI }, scopes: [pets:read] }
  oauth:
    issuer: https://auth.example.com/
    jwksUri: https://auth.example.com/.well-known/jwks.json   # default: discovered
    resource: https://mcp.example.com/mcp                     # default: http.publicUrl
    audience: [https://mcp.example.com/mcp]                   # default: [resource]
    requiredScopes: [mcp:tools]
    scopesSupported: [mcp:tools, pets:read, pets:write]
    algorithms: [RS256, PS256, ES256, EdDSA]
    clockToleranceSec: 30
    introspection:                                            # use instead of JWKS for opaque tokens
      endpoint: https://auth.example.com/oauth/introspect
      clientId: { env: INTROSPECTION_CLIENT_ID }
      clientSecret: { env: INTROSPECTION_CLIENT_SECRET }

authorization:                            # omit = every operation allowed ("implicit-allow-all")
  default: deny                           # when present, defaults to deny
  rules:
    - id: readers
      scopes: [pets:read]                 # principal must hold all of these
      allow: ["method:GET"]
      deny: ["AdminApi.*"]
    - id: ci
      principals: [ci-bot]                # names or opaque ids, globs allowed
      allow: ["PetsApi.*", "tag:owners", "operationId:list*"]
    - id: app
      clientIds: [my-oauth-client]
      allow: ["*"]

execution:
  timeoutMs: 30000                        # default wall-clock limit per execute
  maxTimeoutMs: 120000                    # upper bound for the timeoutMs tool argument
  memoryMb: 256                           # V8 heap limit of each sandbox
  maxConcurrent: 4
  maxQueue: 16
  maxSdkCalls: 200                        # per execution
  maxResultBytes: 65536
  maxLogBytes: 16384
  maxCodeBytes: 100000
  typecheck: true
  denoPath: /usr/local/bin/deno           # default: npm dependency, OAG_MCP_DENO_PATH, PATH

http:
  host: 127.0.0.1                         # loopback by default
  port: 3000
  path: /mcp
  publicUrl: https://mcp.example.com/mcp  # externally visible URL (behind TLS proxy)
  allowedHosts: []                        # Host header allowlist for non-loopback binds
  allowedOrigins: []                      # Origin allowlist (browser clients)
  maxBodyBytes: 1048576

logging:
  level: info
  format: json                            # pretty for local development (stderr only)
  file: /var/log/oag-mcp/operational.log  # or stderr (default) or fd:N
  auditFile: /var/log/oag-mcp/audit.log
  auditFailClosed: false
```

## Authorization patterns

| Pattern | Matches |
| --- | --- |
| `PetsApi.listPets`, `PetsApi.*`, `*.list*` | binding ids (`<ApiClass>.<method>`) |
| `tag:owners` | operations with an OpenAPI tag |
| `method:GET` | HTTP method |
| `operationId:list*` | OpenAPI operationId |

A rule applies when every given selector (`principals`, `scopes`,
`clientIds`) matches. Any applicable `deny` wins; otherwise any applicable
`allow`; otherwise `default`.
