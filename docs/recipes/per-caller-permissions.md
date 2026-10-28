# Per-caller permissions

When several agents or people share one oag-mcp server, they rarely need the
same access. A support assistant may read pets and owners; an operations
agent may also register pets and check the store. This recipe gives each
caller its own set of operations, from who the caller is and what its token
grants.

It builds on the [read-only](read-only.md) and [curated](curated.md) recipes:
the same `authorization` rules, with selectors that say which callers each
rule applies to. Callers are identified by the MCP authentication mode
(`mcpAuth`), which for more than one caller means Streamable HTTP with either
static bearer tokens or OAuth.

For every SDK call, oag-mcp finds the rules that apply to the caller, then
decides:

1. if any of them denies the operation, it is refused;
2. otherwise, if any of them allows it, it is allowed;
3. otherwise `default` decides.

So each caller gets the union of what its rules allow, minus anything they
deny. `search` shows each caller only its own operations, and every decision
is recorded in an audit record naming the caller.

These rules decide what each caller may ask for. They do not change who the
API sees: oag-mcp calls the API with one shared set of upstream credentials,
whichever caller made the call (see
[Authentication](../authentication.md#identity-model)).

## Who the callers are

Each MCP request has a *principal*, made by the authentication mode. Rules
select principals with three selectors:

| Mode | Principal id | Name | Scopes | Client id |
| --- | --- | --- | --- | --- |
| stdio (any `mcpAuth.mode`) | `local:<name>` | `mcpAuth.stdio.principal` | `mcpAuth.stdio.scopes` | None |
| `static-bearer` | `static:<name>` | The token's `principal` | The token's `scopes` | None |
| `oauth` | `oauth:<hash>` of the issuer and the token's subject | None | The access token's scopes | The token's `client_id` |
| `none` (loopback only) | `anonymous` | None | None | None |

| Selector | The rule applies when | Example |
| --- | --- | --- |
| `principals` | The principal's name or id matches one of the patterns (`*` wildcards allowed). | `[support-bot, "team-*"]` |
| `scopes` | The principal holds **all** of these scopes. | `[pets:write]` |
| `clientIds` | The principal's OAuth client id is one of these. Never matches a static bearer or stdio caller. | `[clinic-ops-app]` |

A rule with several selectors applies only when all of them match, and a rule
with none applies to every caller.

Two habits keep rules easy to reason about:

- **Grant capabilities by scope, single out callers by principal or client
  id.** Scopes describe what a token may do (`pets:read`, `pets:write`), so
  one rule serves every caller that holds them. Use `principals` or
  `clientIds` for exceptions that belong to one caller.
- **Keep a `deny` in rules that select narrowly.** A `deny` applies to every
  caller its rule selects, and overrides every other rule's `allow`. A
  `deny: ["method:POST"]` in a rule for `scopes: [pets:read]` would also
  refuse `POST` to a caller that holds `pets:write` as well, since that
  caller holds `pets:read` too.

## Configuration with static bearer tokens

Static bearer tokens are the simplest way to tell callers apart: you give
each caller a long random token, and oag-mcp maps it to a principal and its
scopes. This plan has two callers:

| Caller | Token scopes | May call |
| --- | --- | --- |
| `support-bot` | `pets:read` | pets and owners reads |
| `clinic-ops` | `pets:read`, `pets:write` | the same, plus `PetsApi.createPet` and the store |

Save this as `oag-mcp.per-caller.yaml`:

```yaml
upstreamAuth:
  schemes:
    apiKeyHeader:                       # a security scheme name from your OpenAPI document
      apiKey: { env: API_KEY }

mcpAuth:
  mode: static-bearer
  staticBearer:
    tokens:
      - principal: support-bot
        token: { env: SUPPORT_BOT_TOKEN }
        scopes: [pets:read]
      - principal: clinic-ops
        token: { env: CLINIC_OPS_TOKEN }
        scopes: [pets:read, pets:write]

authorization:
  default: deny
  rules:
    - id: pet-readers                   # every caller holding pets:read
      scopes: [pets:read]
      allow: ["PetsApi.list*", "PetsApi.get*", "OwnersApi.*"]
    - id: pet-writers                   # every caller holding pets:write
      scopes: [pets:write]
      allow: ["PetsApi.createPet"]
    - id: inventory                     # one caller, by name
      principals: [clinic-ops]
      allow: ["tag:store"]
```

The tokens themselves are never in the file: each is a secret reference,
resolved from the environment at start-up. Generate them with, for example,
`openssl rand -hex 32`, and give each caller only its own.

## Running it

Serve over Streamable HTTP. On the default loopback address `127.0.0.1`,
only clients on the same machine can connect:

```bash
export API_KEY=… SUPPORT_BOT_TOKEN=… CLINIC_OPS_TOKEN=…
oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk \
  --config ./oag-mcp.per-caller.yaml \
  --transport streamable-http --port 3000 \
  --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

When it is ready, oag-mcp prints its endpoint on stderr:

```text
oag-mcp listening on http://127.0.0.1:3000/mcp
```

Each caller's MCP client connects to that URL with its own token in the
`Authorization` header. Most MCP clients accept an entry like this:

```json
{
  "mcpServers": {
    "my-api": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <SUPPORT_BOT_TOKEN>" }
    }
  }
}
```

A request without a valid token gets HTTP 401. To serve callers on other
machines, bind a non-loopback `--host` behind a TLS-terminating proxy; see
[Deployment](../deployment.md).

## Configuration with OAuth

With an OAuth 2.0 authorization server, callers bring access tokens it issued,
and oag-mcp validates them as a resource server. Scopes come from the tokens,
so the same scope rules work unchanged; the per-caller exception selects the
OAuth client instead of a principal name, since OAuth principals have no
name:

```yaml
mcpAuth:
  mode: oauth
  oauth:
    issuer: https://auth.example.com/
    requiredScopes: [mcp:tools]         # every token needs this to connect at all

http:
  publicUrl: https://mcp.example.com/mcp   # the URL clients use, behind a TLS proxy

authorization:
  default: deny
  rules:
    - id: pet-readers
      scopes: [pets:read]
      allow: ["PetsApi.list*", "PetsApi.get*", "OwnersApi.*"]
    - id: pet-writers
      scopes: [pets:write]
      allow: ["PetsApi.createPet"]
    - id: inventory                     # one OAuth client
      clientIds: [clinic-ops-app]
      allow: ["tag:store"]
```

`requiredScopes` decides who may connect; the rules decide what each caller
may then do. MCP clients discover the authorization server from oag-mcp's
protected resource metadata and sign the user in themselves. The access token
is only ever used to authenticate the caller: oag-mcp never forwards it to the
API. [Authentication](../authentication.md) covers token validation, JWKS and
introspection.

## What the agents and the logs show

The examples below come from the Pet Clinic API that oag-mcp's tests use,
with the configurations above; the JSON records are shown on several lines,
with some fields left out. This `jq` command prints one line per record, with
the caller:

```bash
tail -f oag-mcp.log | jq -r 'if .class_uid
  then "audit        \(.metadata.event_code) \(.actor.user.uid // .user.uid // "") \(.api.operation // "") \(.status_detail // "") \(.policy.uid // "")"
  else "operational  \(.EventName) \(.Attributes["enduser.id"] // "") \(.Attributes["oag_mcp.operation"] // "") \(.Attributes["http.response.status_code"] // "")"
  end'
```

### What each agent sees

`search` with no arguments lists a different set of methods for each caller:

| `support-bot` | `clinic-ops` |
| --- | --- |
| `OwnersApi.listOwners` | `OwnersApi.listOwners` |
| | `PetsApi.createPet` |
| `PetsApi.getPetById` | `PetsApi.getPetById` |
| `PetsApi.listLegacyPets` | `PetsApi.listLegacyPets` |
| `PetsApi.listPets` | `PetsApi.listPets` |
| `PetsApi.listPetVisits` | `PetsApi.listPetVisits` |
| | `StoreApi.getExternalDocs` |
| | `StoreApi.getStoreInventory` |

### Each caller's calls

Over Streamable HTTP, every MCP request is authenticated, so each tool call
starts with `authentication.succeeded` for its caller. These are four calls,
by the two callers, with the `execution.started`, `execution.completed` and
`execution.failed` records left out:

```text
audit        authentication.succeeded static:support-bot
audit        execution.requested static:support-bot execute
audit        authorization.allowed static:support-bot PetsApi.listPets rule_allow pet-readers
operational  upstream.call.completed static:support-bot PetsApi.listPets 200

audit        authentication.succeeded static:support-bot
audit        execution.requested static:support-bot execute
audit        authorization.denied static:support-bot PetsApi.createPet default_deny default

audit        authentication.succeeded static:clinic-ops
audit        execution.requested static:clinic-ops execute
audit        upstream.token.issue service-identity
audit        authorization.allowed static:clinic-ops PetsApi.createPet rule_allow pet-writers
operational  upstream.call.completed static:clinic-ops PetsApi.createPet 201

audit        authentication.succeeded static:clinic-ops
audit        execution.requested static:clinic-ops execute
audit        authorization.allowed static:clinic-ops StoreApi.getStoreInventory rule_allow inventory
operational  upstream.call.completed static:clinic-ops StoreApi.getStoreInventory 200
```

`support-bot` may list pets but not create one; `clinic-ops` may do both, and
check the store through its own `inventory` rule. A `support-bot` call to the
store would be refused with `default_deny`, like its `createPet`.

`authentication.succeeded` names the caller and how it authenticated:

```json
{
  "time_dt": "2026-10-28T22:19:10.658Z",
  "class_name": "Authentication",
  "activity_name": "Logon",
  "status": "Success",
  "metadata": { "event_code": "authentication.succeeded", "correlation_uid": "req_40686486-14f7-49ae-8319-e2751539eec5" },
  "user": { "uid": "static:support-bot" },
  "auth_protocol": "Bearer Token",
  "src_endpoint": { "ip": "127.0.0.1", "port": 48356 },
  "message": "authentication.succeeded"
}
```

`authorization.allowed` names the caller in `actor.user.uid` and the rule that
allowed the call in `policy.uid`:

```json
{
  "time_dt": "2026-10-28T22:19:11.172Z",
  "class_name": "API Activity",
  "activity_name": "Create",
  "status": "Success",
  "status_detail": "rule_allow",
  "metadata": { "event_code": "authorization.allowed", "correlation_uid": "req_18c52d83-8e96-4941-9e96-32489debdcfa" },
  "actor": { "user": { "uid": "static:clinic-ops" } },
  "api": {
    "operation": "PetsApi.createPet",
    "request": { "uid": "exec_e38086e2-00bb-47f9-9d3c-b0cebbbbd2dd" }
  },
  "src_endpoint": { "ip": "127.0.0.1", "port": 48356 },
  "http_request": { "http_method": "POST", "url": { "path": "/pets" } },
  "action": "Allowed",
  "policy": { "uid": "pet-writers" },
  "message": "authorization.allowed"
}
```

The matching `upstream.call.completed` carries the caller as `enduser.id`,
and the client's address:

```json
{
  "EventName": "upstream.call.completed",
  "Attributes": {
    "oag_mcp.request.id": "req_18c52d83-8e96-4941-9e96-32489debdcfa",
    "network.transport": "tcp",
    "network.protocol.name": "http",
    "enduser.id": "static:clinic-ops",
    "client.address": "127.0.0.1",
    "client.port": 48356,
    "oag_mcp.execution.id": "exec_e38086e2-00bb-47f9-9d3c-b0cebbbbd2dd",
    "oag_mcp.operation": "PetsApi.createPet",
    "http.request.method": "POST",
    "url.template": "/pets",
    "http.response.status_code": 201,
    "oag_mcp.outcome": "success"
  }
}
```

The refused call has `actor.user.uid` `static:support-bot`, `status_detail`
`default_deny` and `policy.uid` `default`: no rule that applies to
`support-bot` allows `PetsApi.createPet`. The agent receives a
`permission_denied` error with reason `authorization_denied`, and nothing is
sent to the API.

`upstream.token.issue` shows the shared upstream identity at work: the API
call that `clinic-ops` made used an OAuth2 token issued to oag-mcp's
`service-identity`, the same one any other caller's calls would use.

### With OAuth

With OAuth, the timeline is the same, with opaque principal ids in place of
names:

```text
audit        authentication.succeeded oauth:fc108540e5fc4e0d
audit        authorization.denied oauth:fc108540e5fc4e0d PetsApi.createPet default_deny default
audit        authentication.succeeded oauth:b292842effa50c8b
audit        authorization.allowed oauth:b292842effa50c8b PetsApi.createPet rule_allow pet-writers
audit        authorization.allowed oauth:b292842effa50c8b StoreApi.getStoreInventory rule_allow inventory
```

Here `oauth:fc108540e5fc4e0d` signed in through the support app with
`pets:read`, and `oauth:b292842effa50c8b` through `clinic-ops-app` with
`pets:read` and `pets:write`. The id is a hash of the issuer and the token's
subject, so it is stable for one user without putting the user's identity in
the logs. `authentication.succeeded` shows the protocol and the validation
used:

```json
{
  "class_name": "Authentication",
  "activity_name": "Logon",
  "status": "Success",
  "metadata": { "event_code": "authentication.succeeded", "…": "…" },
  "user": { "uid": "oauth:fc108540e5fc4e0d" },
  "auth_protocol": "OAUTH 2.0",
  "src_endpoint": { "ip": "127.0.0.1", "port": 40260 },
  "unmapped": { "validation": "jwt", "scopeCount": 2 },
  "message": "authentication.succeeded"
}
```

The [log events reference](../reference/log-events.md) describes every record,
and the [error types reference](../reference/error-types.md) every error.
