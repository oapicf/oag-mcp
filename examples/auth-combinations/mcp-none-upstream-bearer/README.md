# MCP Auth none, Upstream Auth HTTP bearer

An MCP client connects to OAG-MCP over Streamable HTTP, without authentication, and OAG-MCP calls the
Pet Store API with an HTTP bearer token. This is one of the
[MCP Auth and Upstream Auth combinations](../../../docs/recipes/auth-combinations.md).

| File | What it is |
| --- | --- |
| `openapi.yaml` | The Pet Store API, with the `bearerAuth` security scheme |
| `oag-mcp.config.yaml` | The OAG-MCP configuration |
| `generate-sdk.sh` | Generates the typescript-fetch SDK into `generated-sdk/` |
| `serve.sh` | Starts OAG-MCP with the document, the SDK and the configuration |

## Run it

1. Point `upstream.baseUrl` in `oag-mcp.config.yaml` at your API, and
   make sure the API uses the `bearerAuth` scheme as `openapi.yaml` describes it.
2. Generate the SDK, which needs Docker:

   ```bash
   ./generate-sdk.sh
   ```

3. Set the secrets:

   ```bash
   export PETSTORE_TOKEN=…
   ```

4. Start OAG-MCP, which listens on `http://127.0.0.1:3000/mcp`:

   ```bash
   ./serve.sh
   ```

## Connect a client

With Claude Code:

```bash
claude mcp add --transport http petstore http://127.0.0.1:3000/mcp
```

## Check the identity

| Actor | Identified as | Where to look |
| --- | --- | --- |
| The agent | `anonymous` | `actor.user.uid` in audit records |
| OAG-MCP | Its instance id, new for every process | `metadata.reporter.uid` in audit records |
| What the API sees | OAG-MCP's token, as `Authorization: Bearer …`. | `unmapped.schemes` in `authorization.allowed`: `["bearerAuth"]` |

Nobody is authenticated: every caller is `anonymous`, and only processes on this machine can connect, because OAG-MCP refuses to start with `none` on any other address.

Each API call is recorded in `oag-mcp.log`. To list who made each call,
and with which credentials:

```bash
jq -r 'select(.metadata.event_code == "authorization.allowed")
  | "\(.time_dt) \(.actor.user.uid) \(.api.operation) \(.unmapped.schemes | join(","))"' oag-mcp.log
```

[Identity](../../../docs/identity.md) explains these records in full.
