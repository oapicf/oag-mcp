# Configuration reference

`oag-mcp serve --spec <openapi> --sdk <sdk> --config <file>` reads a YAML or
JSON file. Every section is optional; unknown keys are rejected to catch
typos. CLI flags (`--host`, `--port`, `--path`, logging flags) override the
file. The file is read once at start-up, like the spec and SDK; restart
oag-mcp to apply changes.

The inputs themselves are CLI options only:

| Option | Meaning |
| --- | --- |
| `--spec <file>` | OpenAPI 3.0/3.1 document (YAML or JSON); required |
| `--sdk <path>` | existing typescript-fetch SDK: a directory or an `npm pack` archive (`.tgz`); required, never modified |
| `--sdk-layout <layout>` | which layout of the SDK to use: `auto` (default: sources when present), `source` or `compiled` |
| `--sdk-oag-version <x.y.z>` | generator version for SDKs without `.openapi-generator/VERSION` |
| `--allow-untested-oag-version` | accept a generator version outside the tested set |
| `--transport <transport>` | `stdio` (default) or `streamable-http` |

Temporary preparation files go to the OS temporary directory; set `TMPDIR`
to move them (e.g. to a writable volume when the root filesystem is
read-only).

**Secrets are never written in this file.** Every secret is a reference:

```yaml
{ env: NAME }      # environment variable of the oag-mcp process
{ secret: key }    # key in upstreamAuth.secretsFile (YAML/JSON map, chmod 600)
```

Secrets are not accepted as CLI arguments and are never written to the
index, the preparation workspace or logs. They are resolved host-side at
start-up, so a missing environment variable or secrets-file key stops the
server with a configuration error; OAuth2 access tokens are obtained when
first needed.

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
  allowedHosts: []                        # Host names accepted (loopback binds also accept localhost)
  allowedOrigins: []                      # exact browser origins, e.g. https://app.example.com
  maxBodyBytes: 1048576

logging:
  level: info
  format: json                            # pretty for local development (stderr only)
  file: /var/log/oag-mcp/operational.log  # OpenTelemetry records; or stderr (default) or fd:N
  auditFile: /var/log/oag-mcp/audit.log   # OCSF records; or stderr (default) or fd:N
  auditFailClosed: false
```

`http.allowedHosts` and `http.allowedOrigins` protect browsers against DNS
rebinding and cross-site requests. Host names are compared without the port.
Origins are compared exactly (scheme, host and port, as browsers send them),
so `https://app.example.com` does not admit `http://app.example.com` or
`https://app.example.com:8443`; a value that is not an origin, such as a bare
host name or a URL with a path, is a configuration error. Requests without an
Origin header (non-browser MCP clients) are not affected. With no origins
configured, loopback binds accept localhost origins and other binds accept
none.

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
