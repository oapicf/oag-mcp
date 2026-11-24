# MCP Auth stdio, Upstream Auth none

An MCP client connects to OAG-MCP over stdio, as a subprocess the client starts itself, and OAG-MCP calls the
Pet Store API with no credentials. This is one of the
[MCP Auth and Upstream Auth combinations](../../../docs/recipes/auth-combinations.md).

| File | What it is |
| --- | --- |
| `openapi.yaml` | The Pet Store API, without security |
| `oag-mcp.config.yaml` | The OAG-MCP configuration |
| `generate-sdk.sh` | Generates the typescript-fetch SDK into `generated-sdk/` |
| `serve.sh` | Starts OAG-MCP with the document, the SDK and the configuration |

## Run it

1. Point `upstream.baseUrl` in `oag-mcp.config.yaml` at your API.
2. Generate the SDK, which needs Docker:

   ```bash
   ./generate-sdk.sh
   ```

3. No secrets are needed.

4. Connect a client, which starts OAG-MCP itself (see below).

## Connect a client

The MCP client starts `serve.sh` itself, passing it the secrets. With
Claude Code, from this folder:

```bash
claude mcp add petstore -- "$PWD/serve.sh"
```

## Check the identity

| Actor | Identified as | Where to look |
| --- | --- | --- |
| The agent | `local:petstore-agent` | `actor.user.uid` in audit records |
| OAG-MCP | Its instance id, new for every process | `metadata.reporter.uid` in audit records |
| What the API sees | No credentials. | `unmapped.schemes` in `authorization.allowed`: `[]` |

The MCP client starts OAG-MCP as its own subprocess, so the operating system's process boundary is the access control and there is no token. Every call runs as the principal named in `mcpAuth.stdio.principal`.

Each API call is recorded in `oag-mcp.log`. To list who made each call,
and with which credentials:

```bash
jq -r 'select(.metadata.event_code == "authorization.allowed")
  | "\(.time_dt) \(.actor.user.uid) \(.api.operation) \(.unmapped.schemes | join(","))"' oag-mcp.log
```

[Identity](../../../docs/identity.md) explains these records in full.
