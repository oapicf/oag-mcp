# Curated operations

Most APIs have more operations than an agent needs for one job. A support
assistant may need pets and owners but not billing or administration; an
internal reporting agent may need three specific endpoints out of two
hundred. This recipe exposes only a chosen set of operations, picked by
OpenAPI tag, by SDK method, or both.

A curated set is safer, since the agent cannot call what is not in it, and
easier for the agent to work with: `search` returns only the curated methods,
so it chooses from a short, relevant list instead of the whole API.

Curation is an `authorization` policy, like the
[read-only recipe](read-only.md): deny every operation by default, then allow
the chosen ones in a rule. oag-mcp enforces it for every SDK call, whatever
code the agent submits:

- `search` lists only the curated methods. Asking it for any other method by
  id gets the same answer as for a method that does not exist, so the agent
  cannot find out what is hidden.
- An SDK call to anything else is refused before any request is sent, with a
  `permission_denied` error (reason `authorization_denied`) for the agent and
  an `authorization.denied` audit record.

## Choosing the operations

A rule's `allow` and `deny` lists take these patterns:

| Pattern | Matches | Example |
| --- | --- | --- |
| `<ApiClass>.<method>` | One SDK method, by its binding id. | `PetsApi.listPets` |
| A binding id with `*` | Every SDK method whose binding id matches. | `PetsApi.*`, `*.list*` |
| `tag:<tag>` | Every operation with that OpenAPI tag, among its tags. Exact and case-sensitive. | `tag:pets` |
| `operationId:<glob>` | Every operation whose `operationId` in the OpenAPI document matches. | `operationId:list-*` |
| `method:<METHOD>` | Every operation with that HTTP method. | `method:GET` |

A binding id is the API class and method name that the agent calls, as in
`sdk.PetsApi.listPets(…)`. OpenAPI Generator names the class after the
operation's first tag (`pets` becomes `PetsApi`) and the method after its
`operationId`, in camelCase. Two consequences catch people out:

- **`operationId:` uses the document's ids, not the SDK's method names.** An
  operation with `operationId: list-pet-visits` is the SDK method
  `PetsApi.listPetVisits`: `operationId:list-pet-visits` matches it,
  `operationId:listPetVisits` does not. An operation without an `operationId`
  gets a generated method name (such as `AdminApi.healthGet`), and only a
  binding id, tag or method pattern can select it.
- **Tags group operations, not URL paths.** If `DELETE /pets/{petId}` is tagged
  `admin`, it is `AdminApi.deletePet`, and `tag:pets` does not include it.

Tags and binding ids also behave differently as the API grows:

- **By tag**, the set follows the API: an operation added to a curated tag is
  exposed as soon as oag-mcp serves an SDK that has it. Good for "everything
  about pets", when the tag is a trusted boundary.
- **By binding id**, the set is an exact list: a new operation is never
  exposed until you add it. Good when every operation must be reviewed
  first.

To see the binding ids and tags of your API, start oag-mcp once without an
`authorization` section and ask the agent to list the available methods, or
call `search` with no arguments: the result lists every method by binding id,
grouped by API class with its tags.

## Configuration

This example exposes everything tagged `pets` or `owners`, plus one store
method, and carves out a deprecated pets operation. Save it as
`oag-mcp.curated.yaml`:

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
    - id: pet-support
      allow:
        - "tag:pets"                    # every operation tagged pets
        - "tag:owners"                  # every operation tagged owners
        - "StoreApi.getStoreInventory"  # one store method, by binding id
      deny:
        - "PetsApi.listLegacyPets"      # except this one
```

- `allow` lists what the rule allows; an operation needs to match only one
  pattern.
- `deny` carves operations out of the set. A `deny` wins over every `allow`,
  so it is the safe way to exclude one operation from a tag.
- The rule names no `principals`, `scopes` or `clientIds`, so it applies to
  every caller. `default: deny` refuses everything else.

See the [configuration reference](../reference/configuration.md) for every
property.

## Running it

Start oag-mcp with your OpenAPI document, the typescript-fetch SDK generated
from it, and the configuration. With no `--transport`, it serves MCP over
stdio:

```bash
export API_KEY=…
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --config ./oag-mcp.curated.yaml \
  --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

The two log flags write both kinds of record to `./oag-mcp.log`, where you can
follow them; without them, logs go to stderr. To register oag-mcp with an MCP
client, see [Running it](read-only.md#running-it) in the read-only recipe and
use this configuration file.

## What the agent and the logs show

The examples below come from the Pet Clinic API that oag-mcp's tests use,
with the configuration above; the JSON records are shown on several lines,
with some fields left out. This `jq` command prints one line per record:

```bash
tail -f oag-mcp.log | jq -r 'if .class_uid
  then "audit        \(.metadata.event_code) \(.api.operation // "") \(.status_detail // "") \(.policy.uid // "")"
  else "operational  \(.EventName) \(.Attributes["oag_mcp.operation"] // "") \(.Attributes["http.response.status_code"] // "")"
  end'
```

### At start-up

`authorization.policy_loaded` confirms the policy is in force, with one rule
and a default of `deny`:

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

`policyMode: implicit-allow-all` instead means no `authorization` section was
loaded, and every operation is exposed: check that `--config` points at the
right file.

### What the agent sees

`search` with no arguments lists the curated methods, and nothing else: the
`admin` operations, `StoreApi.getExternalDocs` and the carved-out
`PetsApi.listLegacyPets` are absent.

```json
{
  "api": { "title": "Pet Clinic API", "version": "1.2.0" },
  "apis": [
    {
      "api": "OwnersApi",
      "tags": ["owners"],
      "methodCount": 1,
      "methods": [{ "id": "OwnersApi.listOwners", "summary": "List owners" }],
      "more": 0
    },
    {
      "api": "PetsApi",
      "tags": ["pets"],
      "methodCount": 4,
      "methods": [
        { "id": "PetsApi.createPet", "summary": "Register a new pet" },
        { "id": "PetsApi.getPetById", "summary": "Get a pet by its identifier" },
        { "id": "PetsApi.listPets", "summary": "List pets" },
        { "id": "PetsApi.listPetVisits", "summary": "List the vet visits of a pet" }
      ],
      "more": 0
    },
    {
      "api": "StoreApi",
      "tags": ["store"],
      "methodCount": 1,
      "methods": [{ "id": "StoreApi.getStoreInventory", "summary": "Store inventory counts" }],
      "more": 0
    }
  ],
  "hint": "Use search with a query or { tag: <ApiClass or tag> } to list methods; { id } for details."
}
```

Asking for a hidden method by id, here `search { "id": "AdminApi.deletePet" }`,
gets `No method with id "AdminApi.deletePet" is available`, exactly as for a
method that does not exist.

### A call to a curated operation

When the agent calls a curated method, here `OwnersApi.listOwners`, you should
see:

```text
audit        execution.requested execute
operational  execution.started
audit        authorization.allowed OwnersApi.listOwners rule_allow pet-support
operational  upstream.call.completed OwnersApi.listOwners 200
operational  execution.completed
```

`authorization.allowed` names the rule that allowed the call in `policy.uid`:

```json
{
  "time_dt": "2026-10-28T22:05:31.948Z",
  "class_name": "API Activity",
  "activity_name": "Read",
  "status": "Success",
  "status_detail": "rule_allow",
  "metadata": {
    "event_code": "authorization.allowed",
    "correlation_uid": "req_2337b394-2553-4a3d-9161-42d3df82e74d",
    "…": "…"
  },
  "api": {
    "operation": "OwnersApi.listOwners",
    "request": { "uid": "exec_48b98a52-88b4-40a5-afed-f085ed9013f1" }
  },
  "http_request": { "http_method": "GET", "url": { "path": "/owners" } },
  "action": "Allowed",
  "policy": { "uid": "pet-support" },
  "message": "authorization.allowed"
}
```

and `upstream.call.completed` the API's response, under the same request and
execution ids:

```json
{
  "EventName": "upstream.call.completed",
  "Attributes": {
    "oag_mcp.request.id": "req_2337b394-2553-4a3d-9161-42d3df82e74d",
    "oag_mcp.execution.id": "exec_48b98a52-88b4-40a5-afed-f085ed9013f1",
    "oag_mcp.operation": "OwnersApi.listOwners",
    "http.request.method": "GET",
    "url.template": "/owners",
    "http.response.status_code": 200,
    "oag_mcp.duration_ms": 21,
    "http.response.body.size": 125,
    "oag_mcp.outcome": "success"
  }
}
```

### A call outside the set

A call to anything not curated is refused before it reaches the API, and the
audit record says why:

```text
audit        authorization.denied PetsApi.listLegacyPets rule_deny pet-support
audit        authorization.denied AdminApi.healthGet default_deny default
```

- `rule_deny` with `policy.uid` `pet-support`: the operation matches the
  rule's `allow` (it is tagged `pets`) but was carved out by its `deny`.
- `default_deny` with `policy.uid` `default`: no rule allows the operation.

```json
{
  "time_dt": "2026-10-28T22:05:32.158Z",
  "class_name": "API Activity",
  "activity_name": "Read",
  "severity": "Low",
  "status": "Failure",
  "status_detail": "rule_deny",
  "metadata": { "event_code": "authorization.denied", "…": "…" },
  "api": { "operation": "PetsApi.listLegacyPets" },
  "http_request": { "http_method": "GET", "url": { "path": "/legacy/pets" } },
  "action": "Denied",
  "disposition": "Blocked",
  "policy": { "uid": "pet-support" },
  "message": "authorization.denied"
}
```

In both cases there is no `upstream.call.completed`, and the agent receives a
`permission_denied` error naming the operation:

```json
{
  "type": "permission_denied",
  "reason": "authorization_denied",
  "operation": "PetsApi.listLegacyPets",
  "message": "You are not permitted to call PetsApi.listLegacyPets",
  "name": "OagMcpBrokerError"
}
```

The [log events reference](../reference/log-events.md) describes every record,
and the [error types reference](../reference/error-types.md) every error.

## Curated and read-only

Patterns in one `allow` list are alternatives, so a rule cannot say "tagged
`pets` *and* `GET`". To expose only the reads within a curated set, deny the
write methods in the same rule:

```yaml
authorization:
  default: deny
  rules:
    - id: pet-support-read-only
      allow: ["tag:pets", "tag:owners", "StoreApi.getStoreInventory"]
      deny:
        - "PetsApi.listLegacyPets"
        - "method:POST"
        - "method:PUT"
        - "method:PATCH"
        - "method:DELETE"
```

With this rule, `PetsApi.createPet` disappears from `search` and its calls are
refused, while the curated `GET` operations stay available. A rule's `deny`
applies to every operation, not only to those it allows, so writes outside
the curated set, such as `AdminApi.deletePet`, are now refused by this rule
too: their audit records show `rule_deny` and `pet-support-read-only` instead
of `default_deny`. The outcome is the same.
