# 6. One shared upstream identity, no token passthrough

Status: accepted for version 1

## Context

OAG-MCP authenticates MCP callers and calls the API on their behalf. The MCP
specification forbids passing the caller's MCP access token to the API:
that token was issued for OAG-MCP, not for the API. Calling the API as each
individual user needs per-user upstream tokens, which means a consent flow
and a store for those tokens, or token exchange with a shared identity
provider.

## Decision

Version 1 uses one service identity: credentials configured for OAG-MCP
(API keys, bearer tokens, basic authentication, OAuth2 client credentials)
are used for every caller's calls. MCP callers are distinguished inside
OAG-MCP, by authorization rules per operation and by audit records naming
them. The `CredentialProvider` interface receives the caller, so a per-caller
provider can be added later.

## Consequences

- No token store, consent flow or identity-provider integration is needed.
- The API sees one identity: its own per-user permissions and audit do not
  apply, so OAG-MCP's authorization rules and audit log carry that
  responsibility.
- The shared identity is stated in the start-up audit record
  (`credential.provider.configured`, `sharedIdentity: true`).
