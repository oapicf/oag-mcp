# Identity

Three parties take part in every tool call, and each knows the others only
partly:

| Actor | Who it is | How it is identified |
| --- | --- | --- |
| **The agent** | The MCP client, such as Claude Code, acting for a person or a service | As a *principal*, by [MCP Auth](authentication.md#mcp-auth) |
| **OAG-MCP** | The MCP server, between the agent and the API | By name and version to the agent, by an instance id in the logs, and by its upstream credentials to the API |
| **The API** | The upstream API that the SDK calls | Fixed by `upstream.baseUrl` or the OpenAPI document's server URL |

Identity does not pass through from one end to the other. OAG-MCP
authenticates the agent, then calls the API as itself, with its own
credentials. The API never learns which agent, person or token was behind a
call. Only OAG-MCP's logs connect the two, so they are where a call is traced
from the agent to the API.

## The agent

OAG-MCP knows the agent as a principal, set by how the agent connects and by
`mcpAuth.mode`. Every tool call runs as that principal, `authorization` rules
decide what it may do, and every log record of the call names it.

| How the agent connects | Principal id | Proven by | Also known about it |
| --- | --- | --- | --- |
| stdio | `local:<mcpAuth.stdio.principal>`, `local:local` by default | Nothing: OAG-MCP runs as the agent's own subprocess, and the name is configured, not presented | `mcpAuth.stdio.scopes` |
| Streamable HTTP, `mcpAuth.mode: none` | `anonymous` | Nothing; loopback addresses only | Its address and port |
| Streamable HTTP, `mcpAuth.mode: static-bearer` | `static:<principal>`, the name configured for the token | A pre-shared bearer token | The token's scopes; its address and port |
| Streamable HTTP, `mcpAuth.mode: oauth` | `oauth:<keyed hash of issuer and subject>` | An access token from your authorization server | The token's scopes and client id; its address and port |

So the strength of the identity depends on the mode. With stdio, the principal
is whoever started OAG-MCP, and it is as trustworthy as access to that
machine. With `none`, every caller is the same `anonymous`. Only
`static-bearer` and `oauth` tell remote callers apart, and only `oauth` names
an individual person or service account, through your identity provider.

### Tracing an OAuth principal to a user

An OAuth principal id is an HMAC-SHA256 of the token's issuer and subject,
keyed with `mcpAuth.oauth.principalIdKey`, so the logs never show who the user
is. Anyone holding the key can check whether an id belongs to a given user, by
computing the id for that user's subject:

```bash
OAG_MCP_PRINCIPAL_ID_KEY=… node -e '
  const [iss, sub] = process.argv.slice(1);
  const h = require("node:crypto")
    .createHmac("sha256", process.env.OAG_MCP_PRINCIPAL_ID_KEY)
    .update(`${iss}\0${sub}`).digest("hex").slice(0, 16);
  console.log(`oauth:${h}`);
' https://auth.example.com/ alice@example.com
```

The issuer is the token's `iss` claim exactly, including any trailing `/`.
For an introspected token without `iss`, it is `mcpAuth.oauth.issuer`; for a
token without `sub`, the subject is its client id. Without
`principalIdKey`, the key is random and lives only in the running process,
so ids from a past run cannot be traced at all, and they change on every
restart.

### What is not recorded

- **The MCP client's own name.** The name and version a client gives when it
  connects, such as `claude-code`, are self-reported, so OAG-MCP does not use
  or log them.
- **The OAuth client id.** `authorization` rules can match it
  (`clientIds`), but no log record shows it.
- **The person behind a stdio or static bearer principal.** These name a
  configuration entry, not a person: everyone who uses the same token, or the
  same machine, is the same principal.

## OAG-MCP itself

OAG-MCP presents itself differently to each side:

| To | It is | Where |
| --- | --- | --- |
| The agent | `oag-mcp`, with its version and the title `<API title> (oag-mcp)` | The MCP `initialize` response |
| The agent, with `oauth` | The protected resource, `mcpAuth.oauth.resource`, `http.publicUrl` or the local endpoint URL | The [protected resource metadata](reference/http-endpoints.md#endpoints), and the audience its tokens must carry |
| The logs | One server process, by its instance id, with its version and host name | `Resource["service.instance.id"]` in operational records, `metadata.reporter.uid` in audit records |
| The API | Its *service identity*: the upstream credentials in `upstreamAuth` | Each request to the API |

The instance id is new for every process. With several servers behind a load
balancer, it tells you which one handled a call.

## What the API sees

The API sees OAG-MCP, never the agent. Every caller shares OAG-MCP's one
service identity (see
[One identity for every caller](authentication.md#one-identity-for-every-caller)),
so what identifies a request depends only on the security scheme the
operation uses:

| Upstream scheme | The API sees |
| --- | --- |
| None | No credentials: an anonymous request from OAG-MCP's host |
| `apiKey` | OAG-MCP's API key, in the header or query parameter the scheme names |
| `http` `basic` | OAG-MCP's username and password |
| `http` `bearer` | OAG-MCP's token |
| `oauth2` `clientCredentials` | A token issued to OAG-MCP's client id, which OAG-MCP obtained itself |

What never reaches the API:

- **The agent's MCP access token.** It authenticates the agent to OAG-MCP
  only, and is never forwarded.
- **The principal**, or anything else about the agent or the person behind
  it.
- **Credentials the agent's code tries to set.** `Authorization`, `Cookie`,
  `Proxy-Authorization`, and the API key headers and query parameters of the
  document's schemes are removed before the request is sent, and the removal
  is recorded in `strippedCredentials`.
- **A correlation id.** OAG-MCP adds no header of its own that identifies the
  caller, the request or itself.

**Do not trust identity headers.** Other headers the agent's code sets do
reach the API. Code that sends `X-User-Id: admin` has it delivered as it is,
next to OAG-MCP's credentials. An API that takes the caller's identity from
headers like these can be told anything by the agent, so it must take
identity only from the credentials. The `User-Agent` header is `node`, from
the HTTP client OAG-MCP uses, unless the agent's code sets its own.

The requests come from the address of OAG-MCP's host. To match them in the
API's own logs, use the time, method, path and response status, which
OAG-MCP records for each call in `upstream.call.completed`.

## Every combination

Every MCP Auth mode works with every upstream scheme, and the two never
affect each other. The agent's identity comes only from MCP Auth, and the
API's view only from Upstream Auth:

| MCP Auth | Logs name the agent as | Different callers told apart | The API sees |
| --- | --- | --- | --- |
| stdio | `local:<name>` | No: one principal per OAG-MCP process | OAG-MCP's service identity, or nothing with no scheme |
| `none` | `anonymous` | By address and port only | As above |
| `static-bearer` | `static:<name>` | By token | As above |
| `oauth` | `oauth:<hash>` | By user or service account, through your identity provider | As above |

To give the API per-caller identities, implement a `CredentialProvider`
(`lib/upstream/types.ts`), which receives the caller's principal with each
operation. [ADR 0006](decisions/0006-shared-upstream-identity.md) records
why OAG-MCP does not pass callers' own tokens through.

## Finding the actors in the logs

### At start-up

These audit records describe how each actor will be identified, before any
call is served:

| Record | Tells you |
| --- | --- |
| `authentication.mode_configured` | How agents are authenticated: `mode`, and with `oauth` the `validation`, `issuer` and `requiredScopes`. A `warning` without `principalIdKey`. |
| `credential.provider.configured` | Which upstream schemes have credentials (`schemes`), and `sharedIdentity: true`: every caller reaches the API as OAG-MCP. |
| `authorization.policy_loaded` | Whether a policy limits what each principal may do (`policyMode`). |

Every record, at start-up and after, carries the instance id and version of
the OAG-MCP process that wrote it.

### For each call

| Record | The agent | OAG-MCP | The API |
| --- | --- | --- | --- |
| `authentication.succeeded` (audit) | `user.uid`, `auth_protocol`, `src_endpoint` | `metadata.reporter.uid` | None |
| `authentication.failed` (audit) | No principal, since none was established: `src_endpoint`, and the reason in `status_detail` | `metadata.reporter.uid` | None |
| `execution.requested` (audit) | `actor.user.uid` | `metadata.reporter.uid` | None |
| `authorization.allowed`, `authorization.denied` (audit) | `actor.user.uid` | `metadata.reporter.uid` | `api.operation`, `http_request`, and the credentials used: `unmapped.schemes`, `unmapped.unauthenticated`, `unmapped.strippedCredentials` |
| `upstream.token.issue`, `upstream.token.refresh` (audit) | `actor.user.uid`: the caller whose call needed the token | `user.uid` is OAG-MCP's provider, `service-identity` | `service.name`: the scheme the token is for |
| `upstream.call.completed`, `upstream.call.failed` (operational) | `Attributes["enduser.id"]`, `client.address` | `Resource["service.instance.id"]` | `oag_mcp.operation`, `http.request.method`, `url.template`, `http.response.status_code` |

The request id and the execution id join them: see
[Correlation ids](reference/log-events.md#correlation-ids).

### An example

An agent signed in as `alice@example.com` through an OAuth client, and ran
code that listed pets with a forged `Authorization` header and a made-up
`X-User-Id` header, then read the store inventory. With the `jq` command from
the [per-caller permissions recipe](recipes/per-caller-permissions.md#what-the-agents-and-the-logs-show),
the records of the call are:

```text
audit        authentication.succeeded oauth:49be5259e12f1fe6
audit        execution.requested oauth:49be5259e12f1fe6 execute
operational  execution.started oauth:49be5259e12f1fe6
audit        authorization.allowed oauth:49be5259e12f1fe6 PetsApi.listPets rule_allow pet-readers
operational  upstream.call.completed oauth:49be5259e12f1fe6 PetsApi.listPets 200
audit        authorization.allowed oauth:49be5259e12f1fe6 StoreApi.getStoreInventory rule_allow pet-readers
operational  upstream.call.completed oauth:49be5259e12f1fe6 StoreApi.getStoreInventory 200
operational  execution.completed oauth:49be5259e12f1fe6
```

The first `authorization.allowed` shows what the API saw for that call:

```json
{
  "metadata": { "event_code": "authorization.allowed", "correlation_uid": "req_51e537d1-…", "reporter": { "uid": "inst_b2fd4d73-…" }, "…": "…" },
  "actor": { "user": { "uid": "oauth:49be5259e12f1fe6" } },
  "api": { "operation": "PetsApi.listPets", "request": { "uid": "exec_7bf53375-…" } },
  "policy": { "uid": "pet-readers" },
  "unmapped": {
    "provider": "service-identity",
    "schemes": ["apiKeyHeader"],
    "unauthenticated": false,
    "strippedCredentials": ["authorization"]
  }
}
```

Reading it end to end: the agent is `oauth:49be5259e12f1fe6`, which the
holder of `principalIdKey` can confirm is `alice@example.com`. It was served
by OAG-MCP instance `inst_b2fd4d73-…`. The API saw OAG-MCP's API key from the
`apiKeyHeader` scheme, with the forged `Authorization` removed, and the
`X-User-Id` header as the agent's code sent it. The second call used the
`bearerAuth` scheme instead, as `StoreApi.getStoreInventory` requires.

### Useful queries

Everything one agent did, in both kinds of record:

```bash
jq -c 'select(.actor.user.uid == "static:ci-bot" or .user.uid == "static:ci-bot"
  or .Attributes["enduser.id"] == "static:ci-bot")' oag-mcp.log
```

Which agents called an operation, and with which credentials:

```bash
jq -r 'select(.metadata.event_code == "authorization.allowed"
  and .api.operation == "PetsApi.createPet")
  | "\(.time_dt) \(.actor.user.uid) \(.unmapped.schemes | join(","))"' oag-mcp.log
```

Calls whose credentials the agent's code tried to set itself:

```bash
jq -c 'select(.unmapped.strippedCredentials)
  | {time_dt, caller: .actor.user.uid, op: .api.operation, stripped: .unmapped.strippedCredentials}' oag-mcp.log
```

[Logging](logging.md) covers where records go, and the
[log events reference](reference/log-events.md) lists every field.
