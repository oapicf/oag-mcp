# Authorisation

Authorisation decides what each caller may do: which of the API's
operations its agent can find with `search` and call from `execute`. It is
configured in the `authorization` section of the configuration file, and
decided for every SDK call.

Each decision is about a *principal*, the caller that
[authentication](authentication.md) identified, and one operation. The
principal brings its id, its name, and the scopes and client id that came
with its credentials. Authorisation never sees a token, so the same rules
work however the caller authenticated.

Authorisation here is OAG-MCP's own. Your API still applies its own
permissions to the requests it receives, but it sees every caller as the
same [service identity](authentication.md#one-identity-for-every-caller), so
limits that differ between callers must be set in OAG-MCP.

## The policy

Without an `authorization` section, every caller may call every operation.
OAG-MCP says so at start-up, in the `authorization.policy_loaded` audit record
(`policyMode: implicit-allow-all`). That suits trying OAG-MCP out on a
local machine; anywhere else, write a policy.

A policy is a default and a list of rules:

```yaml
authorization:
  default: deny                  # what happens when no rule decides
  rules:
    - id: read-only              # named in audit records
      allow: [method:GET]
    - id: admins
      principals: [static:ops-*]
      allow: [AdminApi.*]
    - id: no-deletes
      deny: [operationId:delete*]
```

Each rule says **which callers** it applies to and **which operations** it
allows or denies:

- **Callers.** `principals` (names or ids, with `*` wildcards), `scopes`
  (the caller must have all of them) and `clientIds` (any of them). A rule
  applies when every selector it sets matches, and a rule with none applies
  to every caller.
- **Operations.** `allow` and `deny` list patterns: an SDK method such as
  `PetsApi.listPets` or `PetsApi.*`, `tag:<tag>`, `method:<METHOD>` or
  `operationId:<glob>`.

For each SDK call, OAG-MCP looks at the rules that apply to the caller. If
any of them denies the operation, the call is refused. Otherwise, if any
allows it, the call goes ahead. Otherwise `default` decides. A deny always
wins, so a broad allow can be narrowed with a deny, as `no-deletes` does
above.

The [configuration reference](reference/configuration.md#authorisation-patterns)
lists every property and pattern.

## Where it is enforced

Authorisation is checked in two places:

- **`search`** shows only the operations the caller may call. An agent is
  not shown methods it could not use, and asking for one by id gets the same
  answer as asking for one that does not exist.
- **The broker** checks every SDK call that `execute`'s code makes, before
  any credentials are looked up or the API is contacted. A refused call fails
  with `permission_denied` (reason `authorization_denied`); if the code does
  not catch it, the `execute` call returns that error.

The broker's check is the control. Hiding a method from `search` only saves
the agent a wasted attempt: code that calls a hidden method directly is
still refused.

One `execute` call can make many SDK calls, and each is decided on its own.
Every attempted SDK call produces exactly one decision record in the audit
log: `authorization.allowed` or `authorization.denied`, naming the rule that
decided (`policy.uid`), or `network.destination_denied` or
`credential.lookup_failed` when it fails for another reason. The
[log events reference](reference/log-events.md#audit-events) describes them.

## What it does not cover

Other controls limit what a call can do, whatever the policy says:

- **`mcpAuth.oauth.requiredScopes`** belongs to authentication: a token
  without those scopes cannot use OAG-MCP at all, and gets `403`. Use it for
  a coarse "may use this server" check, and authorisation rules for
  per-operation decisions.
- **The broker's network checks** send each request only to the configured
  base URL, and only as the operation it claims to be.
- **The sandbox** stops agent code reaching the network, files or
  environment directly, so the SDK, and therefore the policy, is the only way
  out.
- **Execution limits** bound how much a caller can do in one call.

[Security](security.md) describes each of them.

## Recipes

- [Read-only server](recipes/read-only.md): allow only `GET` operations.
- [Curated operations](recipes/curated.md): allow only some operations, by
  tag or SDK method.
- [Per-caller permissions](recipes/per-caller-permissions.md): give each
  caller its own operations, from static bearer tokens or OAuth scopes.
