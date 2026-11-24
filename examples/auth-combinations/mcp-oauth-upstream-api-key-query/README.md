# MCP Auth OAuth, Upstream Auth API key in the query

An MCP client connects to OAG-MCP over Streamable HTTP, with an OAuth access token from your authorization server, and OAG-MCP calls the
Pet Store API with an API key in the `api_key` query parameter. This is one of the
[MCP Auth and Upstream Auth combinations](../../../docs/recipes/auth-combinations.md).

| File | What it is |
| --- | --- |
| `openapi.yaml` | The Pet Store API, with the `apiKeyQuery` security scheme |
| `oag-mcp.config.yaml` | The OAG-MCP configuration |
| `generate-sdk.sh` | Generates the typescript-fetch SDK into `generated-sdk/` |
| `serve.sh` | Starts OAG-MCP with the document, the SDK and the configuration |

## Run it

1. Point `upstream.baseUrl` in `oag-mcp.config.yaml` at your API, and
   make sure the API uses the `apiKeyQuery` scheme as `openapi.yaml` describes it.
2. Generate the SDK, which needs Docker:

   ```bash
   ./generate-sdk.sh
   ```

3. Set the secrets:

   ```bash
   export OAG_MCP_PRINCIPAL_ID_KEY=…
   export PETSTORE_API_KEY=…
   ```

4. Start OAG-MCP, which listens on `http://127.0.0.1:3000/mcp`:

   ```bash
   ./serve.sh
   ```

## Connect a client

Clients that support the MCP authorization flow read OAG-MCP's protected
resource metadata, find your authorization server, and sign in there:

```bash
claude mcp add --transport http petstore http://127.0.0.1:3000/mcp
```

Or send a token you already have, with the `mcp:tools` scope and
`http://127.0.0.1:3000/mcp` as its audience:

```bash
claude mcp add --transport http petstore http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $ACCESS_TOKEN"
```

## Check the identity

| Actor | Identified as | Where to look |
| --- | --- | --- |
| The agent | `oauth:<keyed hash of issuer and subject>` | `actor.user.uid` in audit records |
| OAG-MCP | Its instance id, new for every process | `metadata.reporter.uid` in audit records |
| What the API sees | OAG-MCP's API key, in the `api_key` query parameter. | `unmapped.schemes` in `authorization.allowed`: `["apiKeyQuery"]` |

The MCP client sends an access token from your authorization server, which OAG-MCP validates on every request. The principal is a keyed hash of the token's issuer and subject, so the logs never show who the user is, and only the holder of `principalIdKey` can match an id to a user.

Each API call is recorded in `oag-mcp.log`. To list who made each call,
and with which credentials:

```bash
jq -r 'select(.metadata.event_code == "authorization.allowed")
  | "\(.time_dt) \(.actor.user.uid) \(.api.operation) \(.unmapped.schemes | join(","))"' oag-mcp.log
```

[Identity](../../../docs/identity.md) explains these records in full.
