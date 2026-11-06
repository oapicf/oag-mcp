# Troubleshooting

This page works back from what you see to why: OAG-MCP not starting, an MCP
client not connecting, an `execute` call failing, or a method the agent
cannot find. Most answers are already in OAG-MCP's output; the steps below
say where to look.

To have everything in one place, start OAG-MCP with both kinds of log in a
file:

```bash
oag-mcp serve … --log-file ./oag-mcp.log --audit-log-file ./oag-mcp.log
```

## OAG-MCP does not start

OAG-MCP prepares the OpenAPI document and the SDK, checks the configuration
and resolves credentials before it serves anything, and stops at the first
problem. It prints one error to stderr, with a stable code and, usually, a
hint. The [error codes reference](reference/error-codes.md) lists every code:

```text
Error [CONFIG_INVALID]: Invalid configuration in /srv/oag-mcp/oag-mcp.yaml: upstream: Unrecognized key: "timeoutMS"; execution.memoryMb: Too small: expected number to be >=32
Hint: See docs/reference/configuration.md. Secret values must be referenced with { env: NAME } or { secret: key }, never written inline.
```

The configuration is checked before logging starts, so a configuration
error appears only on stderr, not in the log file. Every problem in the file
is listed at once (up to eight), each with its property's path.

| Error code | Usually means | See |
| --- | --- | --- |
| `CONFIG_INVALID`, `CONFIG_NOT_FOUND` | A typo, a value out of range, or a wrong `--config` path. | [Configuration reference](reference/configuration.md) |
| `UPSTREAM_AUTH_CONFIG_INVALID` | A credential's environment variable is not set, a secrets file is readable by others, a scheme name is not in the OpenAPI document, or a token URL is not HTTPS. | [Upstream credentials](recipes/upstream-credentials.md) |
| `MCP_AUTH_REQUIRED` | Streamable HTTP on a non-loopback address without `mcpAuth`. | [Remote server](recipes/remote-server.md) |
| `SDK_OAG_VERSION_UNKNOWN`, `SDK_OAG_VERSION_UNSUPPORTED`, `SDK_OAG_VERSION_CONFLICT`, `SDK_LAYOUT_UNSUPPORTED` | The SDK's generator version or layout. | [Packaged SDK](recipes/packaged-sdk.md) |
| `SDK_GENERATOR_UNSUPPORTED`, `SDK_OPTION_UNSUPPORTED` | The SDK was not made by the typescript-fetch generator, or with options OAG-MCP does not support. | [SDK compatibility](sdk-compatibility.md) |
| `CONFIG_BASE_URL_REQUIRED` | The OpenAPI document has no absolute server URL. Set `upstream.baseUrl`. | [Configuration reference](reference/configuration.md) |

Once logging has started, the log also says which preparation stage failed:
`prepare.stage.failed` has `oag_mcp.stage` (`inputs`, `compatibility`, `sdk`,
`index` or `executor`) and `error.type`, the same code as on stderr.

## An MCP client cannot connect

For a stdio server, the MCP client starts OAG-MCP itself, so OAG-MCP's error
ends up in the client's own log, if anywhere. Run the exact command from the
client's configuration in a terminal, with a minimal MCP handshake, to see
what happens:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
  | oag-mcp serve --spec /path/to/openapi.yaml --sdk /path/to/generated-sdk \
      --config /path/to/oag-mcp.yaml --log-level silent
```

A working server answers with one line of JSON, starting
`{"result":{"protocolVersion":…`, and exits when its input ends. Otherwise you
see the start-up error. If it works in a terminal but not in the client:

- The client may not find `oag-mcp` or `node` on its `PATH`. Desktop apps
  often start with a shorter `PATH` than your shell. Use the absolute path
  from `which oag-mcp` as the `command`.
- Relative paths are resolved from wherever the client starts OAG-MCP. Use
  absolute paths for `--spec`, `--sdk`, `--config` and the log files.
- Environment variables your shell sets are not set for the client. Put the
  credentials OAG-MCP needs in the client entry's `env`.

For a Streamable HTTP server, `curl http://127.0.0.1:3000/healthz` should
answer `{"status":"ok"}`. A `401` means the client sends no token or the
wrong one; a `403` with `Invalid Host`, `Invalid Origin` or `Origin not allowed` means the
`http.allowedHosts` or `http.allowedOrigins` settings do not include what the
client sends. [Remote server](recipes/remote-server.md) covers each.

## An execute call failed

The agent receives the error, and usually shows or quotes it. Start from its
`type`; the [error types reference](reference/error-types.md) says what
each means and what to do. For example:

```json
{
  "ok": false,
  "executionId": "exec_1a91d812-e500-4f06-9fb2-e43a6fd31b85",
  "error": {
    "type": "runtime_error",
    "name": "TypeError",
    "message": "Cannot read properties of null (reading 'map')",
    "line": 1,
    "column": 20,
    "thrownIn": "JSONApiResponse.transformer"
  },
  "hint": "The error was thrown inside the SDK (JSONApiResponse.transformer), not in your code. The API's response may not match the OpenAPI document the SDK was generated from.",
  "stats": { "durationMs": 155, "sdkCalls": 1 }
}
```

### Following one execution through the logs

The `executionId` identifies the call in every record about it. This prints
them in order:

```bash
ID=exec_1a91d812-e500-4f06-9fb2-e43a6fd31b85
jq -c --arg id "$ID" '
  select(.Attributes["oag_mcp.execution.id"] == $id or .api.request.uid == $id
         or .process.uid == $id or .unmapped.executionId == $id)
  | if .class_uid
    then {audit: .metadata.event_code, operation: .api.operation, detail: .status_detail}
    else {operational: .EventName, attributes: (.Attributes | with_entries(select(.key | test("^oag_mcp[.]operation$|status_code|error|outcome|duration|sdk_calls"))))}
    end' oag-mcp.log
```

For the error above:

```text
{"audit":"execution.requested","operation":"execute","detail":null}
{"operational":"execution.started","attributes":{}}
{"audit":"authorization.allowed","operation":"PetsApi.listPetVisits","detail":"no_policy_configured"}
{"operational":"upstream.call.completed","attributes":{"oag_mcp.operation":"PetsApi.listPetVisits","http.response.status_code":200,"oag_mcp.duration_ms":25,"oag_mcp.outcome":"success"}}
{"operational":"execution.failed","attributes":{"oag_mcp.duration_ms":155,"oag_mcp.sdk_calls":1,"error.type":"runtime_error","oag_mcp.outcome":"failure"}}
```

The sequence tells most stories:

| You see | It means |
| --- | --- |
| No `authorization.allowed` for the operation, but `authorization.denied` | The `authorization` policy refused it. |
| `credential.lookup_failed` | No credentials for the operation's security scheme. |
| `upstream.call.completed` with a 4xx or 5xx status | The API refused or failed; the agent's `api_error` has the response body. |
| `upstream.call.failed` | No response: the API is unreachable or slower than `upstream.timeoutMs`. |
| `upstream.call.completed` with 200, then a `runtime_error` with `thrownIn` | The API answered, but the SDK could not read the answer. |
| `execution.timeout` or `execution.resource_limit` | A limit was reached; see [Execution limits](recipes/execution-limits.md). |

### When the API's answer does not match the OpenAPI document

The last pattern deserves a closer look, because it is not the agent's
fault. Here the API answered `200`, and the SDK's code failed while reading
the body: it expected a list, as the OpenAPI document says, and got `null`.
The agent can change nothing to fix it.

This happens when the OpenAPI document, and the SDK generated from it, no
longer match the live API: an older version of the document, a field that
can be `null` but is not marked `nullable`, or an error returned with HTTP
status 200. To find which:

1. Check the OpenAPI document is the current version for the API you call.
2. Call the API yourself, outside OAG-MCP, with the same parameters, and
   compare the response with the operation's response schema.
3. Fix or update the document, regenerate the SDK, and restart OAG-MCP.

OAG-MCP never logs response bodies, so step 2 is how to see what the API
returned.

## The agent cannot find a method

`search` lists only the methods the caller may call. If one is missing:

1. **The `authorization` policy may hide it.** Ask `search` for it by id, as
   in `search { "id": "PetsApi.createPet" }`. A hidden method gets the same
   `No method with id … is available` as one that does not exist; check the
   rules that apply to the caller (see [Per-caller permissions](recipes/per-caller-permissions.md)).
2. **The SDK may not have it.** The method index comes from the SDK, not the
   OpenAPI document: an SDK generated from an older document lacks newer
   operations. `prepare.index.created` gives the number of `methods`, and
   `prepare.warning` names any operation of the document that could not be
   matched to an SDK method.
3. **It may be under another name.** OpenAPI Generator names methods after
   `operationId` in camelCase (`list-pet-visits` becomes `listPetVisits`),
   and classes after the operation's first tag. Browse with `search` and no
   arguments to see every method by its SDK name.

## More detail: debug logging

`--log-level debug` adds the records that are usually too detailed, and
`--log-format pretty` makes them readable on a terminal (stderr only):

```bash
oag-mcp serve … --log-level debug --log-format pretty
```

```text
[21:15:39.076] DEBUG: [operational] upstream.call.redirected
    Attributes: {
      "oag_mcp.execution.id": "exec_e52c5500-4988-4547-b323-7b7546611e76",
      "oag_mcp.operation": "PetsApi.listLegacyPets",
      "http.response.status_code": 302,
      "oag_mcp.same_origin": true
    }
[21:15:39.087] INFO: [operational] upstream.call.completed success
```

The debug records are `prepare.stage.started`, `prepare.workspace.removed`,
`typecheck.warmed`, `upstream.call.redirected` and `upstream.token.cache_hit`.
Even at debug level, OAG-MCP logs no agent code, search queries, request or
response bodies, results or credentials.

The [log events reference](reference/log-events.md) describes every record.
