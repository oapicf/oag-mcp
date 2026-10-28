# Read-only server

A good first step with oag-mcp is to expose only your API's read operations.
An agent can then search the API and fetch data through it, but cannot create,
change or delete anything. That makes it a safe way to try oag-mcp against a
real API before deciding what else to allow.

Read-only access is set with an `authorization` policy: deny every operation
by default, and allow the ones whose HTTP method is `GET`. oag-mcp enforces it
on its own side, for every SDK call, whatever code the agent submits:

- `search` lists only the methods the policy allows, so the agent never sees
  the write operations.
- An SDK call to anything else is refused before any request is sent. The
  agent gets a `permission_denied` error with reason `authorization_denied`,
  and oag-mcp writes an `authorization.denied` audit record.

The policy goes by HTTP method, so it is only as read-only as your API is: a
`GET` operation that changes data, or returns data the agent should not see,
is still allowed. Check the `GET` operations in your OpenAPI document, and
where your API supports it, give oag-mcp read-only credentials as well, so
the API itself refuses writes too.

## Configuration

Save this as `oag-mcp.read-only.yaml`:

```yaml
upstream:
  baseUrl: https://api.example.com/v1   # optional: defaults to the OpenAPI document's first server

upstreamAuth:
  schemes:
    apiKeyHeader:                       # a security scheme name from your OpenAPI document
      apiKey: { env: API_KEY }          # read from the API_KEY environment variable

authorization:
  default: deny                         # anything no rule allows is refused
  rules:
    - id: read-only
      allow: ["method:GET"]             # allow every GET operation
```

- `upstreamAuth.schemes` holds the credentials oag-mcp uses to call your API,
  keyed by the names under `components.securitySchemes` in your OpenAPI
  document. The file only references the key; its value comes from the
  environment when oag-mcp starts. Leave the section out if your API needs no
  credentials.
- The `read-only` rule names no `principals`, `scopes` or `clientIds`, so it
  applies to every caller. `default: deny` refuses everything else.
- If your API has `HEAD` or `OPTIONS` operations you want to allow, add
  `"method:HEAD"` or `"method:OPTIONS"` to `allow`.

See the [configuration reference](../reference/configuration.md) for every
property.

## Running it

Start oag-mcp with your OpenAPI document, the typescript-fetch SDK generated
from it, and the configuration. With no `--transport`, it serves MCP over
stdio, for an MCP client on the same machine:

```bash
export API_KEY=…
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --config ./oag-mcp.read-only.yaml \
  --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

Without the two log flags, the logs go to stderr, which an MCP client usually
keeps in its own log files. With them, both kinds of record go to
`./oag-mcp.log`, where you can follow them.

Most MCP clients start a stdio server from an entry like this in their
configuration:

```json
{
  "mcpServers": {
    "my-api-read-only": {
      "command": "oag-mcp",
      "args": [
        "serve",
        "--spec", "/path/to/openapi.yaml",
        "--sdk", "/path/to/generated-sdk",
        "--config", "/path/to/oag-mcp.read-only.yaml",
        "--log-file", "/path/to/oag-mcp.log",
        "--audit-log-file", "/path/to/oag-mcp.log"
      ],
      "env": { "API_KEY": "…" }
    }
  }
}
```

Use absolute paths there, since the client may start oag-mcp from any folder.
Then ask the agent something that needs your API's data, such as "list three
pets".

## What the logs show

The examples below come from the Pet Clinic API that oag-mcp's tests use,
with the configuration above; the JSON records are shown on several lines,
with some fields left out. This `jq` command prints one line per record: the
event, and for SDK calls the operation and the outcome.

```bash
tail -f oag-mcp.log | jq -r 'if .class_uid
  then "audit        \(.metadata.event_code) \(.api.operation // "") \(.status_detail // "") \(.policy.uid // "")"
  else "operational  \(.EventName) \(.Attributes["oag_mcp.operation"] // "") \(.Attributes["http.response.status_code"] // "")"
  end'
```

### At start-up

Among the start-up records, `authorization.policy_loaded` confirms that the
policy is in force. Its `unmapped` details show one rule and a default of
`deny`:

```text
audit        credential.provider.configured
audit        authorization.policy_loaded
audit        execution.policy.applied
audit        authentication.succeeded
operational  transport.initialized
operational  server.ready
```

```json
{
  "class_name": "Application Lifecycle",
  "activity_name": "Configure",
  "status": "Success",
  "metadata": { "event_code": "authorization.policy_loaded", "…": "…" },
  "unmapped": { "policyMode": "configured", "rules": 1, "default": "deny" },
  "message": "authorization.policy_loaded"
}
```

If `policyMode` is `implicit-allow-all`, the configuration has no
`authorization` section and every operation is allowed: check that
`--config` points at the right file.

### A successful read

When the agent calls a `GET` operation, here `PetsApi.listPets`, you should
see this sequence:

```text
operational  search.completed
audit        execution.requested execute
operational  execution.started
audit        authorization.allowed PetsApi.listPets rule_allow read-only
operational  upstream.call.completed PetsApi.listPets 200
operational  execution.completed
```

`authorization.allowed` is the decision. `status_detail` is `rule_allow` and
`policy.uid` is `read-only`: the call was allowed by the `read-only` rule,
and sent with the `apiKeyHeader` credentials.

```json
{
  "time": 1793060605907,
  "time_dt": "2026-10-27T00:23:25.907Z",
  "class_name": "API Activity",
  "activity_name": "Read",
  "severity": "Informational",
  "status": "Success",
  "status_detail": "rule_allow",
  "metadata": {
    "event_code": "authorization.allowed",
    "correlation_uid": "req_2c32c71e-4858-4d46-9d3b-ce06f2b1e8f7",
    "…": "…"
  },
  "actor": { "user": { "uid": "local:local" } },
  "api": {
    "operation": "PetsApi.listPets",
    "request": { "uid": "exec_429bd1ad-ffde-4049-9d71-5fa1e13816ba" },
    "service": { "name": "oag-mcp", "version": "0.9.0-pre.0" }
  },
  "http_request": { "http_method": "GET", "url": { "path": "/pets" } },
  "action": "Allowed",
  "disposition": "Allowed",
  "policy": { "uid": "read-only" },
  "unmapped": {
    "jsonrpcRequestId": 3,
    "provider": "service-identity",
    "schemes": ["apiKeyHeader"],
    "unauthenticated": false
  },
  "message": "authorization.allowed"
}
```

`upstream.call.completed` is the API's response: status 200, with its
duration and size. The request id and execution id are the same as in the
audit record, so the two can be matched.

```json
{
  "SeverityText": "INFO",
  "Timestamp": "1793060605948000000",
  "EventName": "upstream.call.completed",
  "Attributes": {
    "oag_mcp.request.id": "req_2c32c71e-4858-4d46-9d3b-ce06f2b1e8f7",
    "network.transport": "pipe",
    "enduser.id": "local:local",
    "gen_ai.tool.name": "execute",
    "oag_mcp.execution.id": "exec_429bd1ad-ffde-4049-9d71-5fa1e13816ba",
    "oag_mcp.operation": "PetsApi.listPets",
    "http.request.method": "GET",
    "url.template": "/pets",
    "http.response.status_code": 200,
    "oag_mcp.duration_ms": 38,
    "http.response.body.size": 332,
    "oag_mcp.outcome": "success"
  },
  "Body": "upstream.call.completed"
}
```

`execution.completed` then closes the `execute` call, with
`oag_mcp.outcome` `success` and `oag_mcp.sdk_calls` 1.

### A refused write

To check that writes really are refused, ask the agent to create something.
It won't find a create method with `search`, but if its code calls one anyway,
here `PetsApi.createPet`, the call is refused before reaching the API:

```text
audit        execution.requested execute
operational  execution.started
audit        authorization.denied PetsApi.createPet default_deny default
operational  execution.failed
```

The audit record has `status_detail` `default_deny`, `policy.uid` `default`
and `action` `Denied`. There is no `upstream.call.completed`, because no
request was sent. The agent receives:

```json
{
  "type": "permission_denied",
  "reason": "authorization_denied",
  "operation": "PetsApi.createPet",
  "message": "You are not permitted to call PetsApi.createPet",
  "name": "OagMcpBrokerError"
}
```

The [log events reference](../reference/log-events.md) describes every record,
and the [error types reference](../reference/error-types.md) every error.

## Next steps

When you are ready to allow more, add rules rather than removing the default.
For example, to let one trusted caller also write pets (here `ci-bot`, a
Streamable HTTP caller authenticated with `mcpAuth.mode: static-bearer`):

```yaml
authorization:
  default: deny
  rules:
    - id: read-only
      allow: ["method:GET"]
    - id: pet-writers
      principals: [ci-bot]
      allow: ["PetsApi.*"]
      deny: ["PetsApi.deletePet"]
```

Rules can match callers by `principals`, `scopes` or OAuth `clientIds`, and
operations by method, tag, `operationId` or SDK method name. A `deny` in any
rule that applies wins over every `allow`.
