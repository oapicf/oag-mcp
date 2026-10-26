# Error types reference

When an `execute` call fails, its result has `ok: false` and an `error` object
whose `type` says what kind of failure it was. The MCP tool result is marked
`isError: true`, and carries the same payload as structured content and as
JSON text:

```json
{
  "ok": false,
  "executionId": "exec_…",
  "error": {
    "type": "api_error",
    "name": "ResponseError",
    "message": "The API responded with HTTP 404 Not Found",
    "status": 404,
    "body": "{\"code\":\"not_found\",\"message\":\"pet 404 not found\"}",
    "line": 2,
    "column": 12
  },
  "logs": [],
  "logsTruncated": false,
  "stats": { "durationMs": 41, "sdkCalls": 1 }
}
```

`type` is one of the 14 values below, and is stable: agents and programs can
branch on it. `message` is for the agent to read and may change between
versions. Some errors add a `reason` that narrows the type down (see
[Reasons](#reasons)), and some results add a `hint` beside the error with a
suggested next step. Error objects never contain stack traces, sandbox paths
or credentials: known secrets are scrubbed and long values are cut short.
`line` and `column` are 1-based and point into the submitted code.

Errors from SDK calls are thrown inside the agent's code, at the call site,
where they can be caught with `try`/`catch`: the SDK's own `ResponseError`
(`api_error`) and `RequiredError` (`sdk_error`), and `OagMcpBrokerError` for
calls the request broker refused or could not complete. Only an error the code
doesn't catch ends the execution and becomes the result's `error`.

The **Stage** column says how far an execution got before it failed, which
decides whether a retry is safe:

- **Before running:** the code was rejected or never started. No code ran and
  no API calls were made.
- **SDK call:** an SDK call failed. API calls made earlier in the same
  execution may already have taken effect.
- **While running:** the code failed or was stopped while running. Earlier API
  calls may have taken effect.
- **After running:** the code finished, so every API call it made has taken
  effect, but its result could not be returned. Running the same code again
  repeats those calls.

These are the errors of the `execute` tool. Start-up failures (an invalid
configuration file, an incompatible SDK) are not among them: they stop
`oag-mcp serve` with an error code and hint on stderr. MCP protocol errors,
such as invalid tool arguments or an HTTP 401 from `mcpAuth`, are reported by
the MCP transport, not as an execution error.

## Error types

| Error type | Description | Stage | Fields | What to do | Example |
| --- | --- | --- | --- | --- | --- |
| `syntax_error` | The code does not parse as TypeScript or JavaScript. | Before running | `diagnostics` (`line`, `column`, `code`, `message`; at most 10) | Agent: fix the code at the reported line. | `{"type":"syntax_error","message":"Code has 1 syntax error(s): Expression expected. (line 1)","diagnostics":[{"line":1,"column":11,"code":1109,"message":"Expression expected."}]}` |
| `type_error` | The TypeScript code does not type-check against the SDK's types: an unknown method or property, a wrong argument shape. Only when `execution.typecheck` is on and the code is TypeScript. Returned with a `hint`. | Before running | `diagnostics` | Agent: look up the method with `search { id }` and fix the call. | `{"type":"type_error","message":"Code has 1 type error(s): Property 'nmae' does not exist on type 'Pet'. (line 2)","diagnostics":[{"line":2,"column":26,"code":2339,"message":"Property 'nmae' does not exist on type 'Pet'."}]}` |
| `permission_denied` | Something the security policy forbids: an import, a sandbox capability (file system, network, environment, subprocesses, `eval`), an operation the caller's `authorization` rules deny, or a request or redirect outside the configured API. `reason` says which. | Before running (imports), SDK call, while running (capabilities) | `reason`; `operation` (SDK calls); `capability` (`read`, `write`, `net`, `env`, `run`, `ffi`, `sys`, `eval`); `line`, `column` | Agent: use only the `sdk` binding, and don't retry denied operations. Operator: if the caller should be allowed, change the `authorization` rules. | `{"type":"permission_denied","reason":"authorization_denied","operation":"PetsApi.createPet","message":"You are not permitted to call PetsApi.createPet","name":"OagMcpBrokerError"}`, `{"type":"permission_denied","name":"NotCapable","reason":"sandbox_capability_denied","capability":"read","message":"Requires read access to \"/etc/hostname\"","line":1,"column":17}` |
| `api_error` | The API answered with an HTTP error status (4xx or 5xx). This includes a 401 or 403 that rejects oag-mcp's upstream credentials. | SDK call | `status`; `body` (at most 2000 characters); `line`, `column` | Agent: read `status` and `body`, fix the request or handle the case. Operator: for 401 or 403, check the `upstreamAuth` credentials. | `{"type":"api_error","name":"ResponseError","message":"The API responded with HTTP 404 Not Found","status":404,"body":"{\"code\":\"not_found\",\"message\":\"pet 404 not found\"}","line":2,"column":12}` |
| `sdk_error` | The SDK refused a call before sending it, because a required parameter was missing. | SDK call | `field`; `line`, `column` | Agent: pass the named parameter. | `{"type":"sdk_error","name":"RequiredError","message":"Required parameter \"petId\" was null or undefined when calling getPetById().","field":"petId","line":1,"column":30}` |
| `upstream_auth_error` | oag-mcp has no usable credentials for the operation: none configured for its security schemes, schemes it cannot satisfy, or an OAuth2 token it could not obtain. The request was not sent. | SDK call | `reason`; `operation` | Operator: configure the scheme under `upstreamAuth.schemes`, or fix the token endpoint. Agent: report it; retrying won't help. | `{"type":"upstream_auth_error","reason":"token_request_failed","operation":"PetsApi.createPet","message":"The OAuth2 token endpoint rejected the client credentials request for \"clinicOAuth\" (HTTP 401)","name":"OagMcpBrokerError"}` |
| `upstream_unreachable` | The API could not be reached, or did not answer within `upstream.timeoutMs`. | SDK call | `reason`; `operation` | Agent: retry later. Operator: check `upstream.baseUrl` and the network, or raise `upstream.timeoutMs`. | `{"type":"upstream_unreachable","reason":"network_error","operation":"PetsApi.listPets","message":"The API could not be reached","name":"OagMcpBrokerError"}` |
| `runtime_error` | The code threw an error that is not one of the above. When it was thrown inside the SDK, not in the agent's code, `thrownIn` names the SDK function and a `hint` suggests the API's response may not match the OpenAPI document. | While running | `name`; `line`, `column`; `thrownIn` | Agent: fix the code. With `thrownIn`, the API's response doesn't fit the SDK's model, and changing the code won't fix it; report it. Operator: with `thrownIn`, check that the OpenAPI document and SDK match the live API. | `{"type":"runtime_error","name":"RangeError","message":"limit must be positive","line":1,"column":11}`, `{"type":"runtime_error","name":"TypeError","message":"Cannot read properties of null (reading 'map')","line":1,"column":20,"thrownIn":"JSONApiResponse.transformer"}` |
| `timeout` | The execution ran past its time limit and was terminated: the call's `timeoutMs`, else `execution.timeoutMs`, capped at `execution.maxTimeoutMs`. | While running | None | Agent: do less per call, or pass a larger `timeoutMs`. Operator: raise `execution.timeoutMs` or `execution.maxTimeoutMs`. | `{"type":"timeout","message":"Execution exceeded the 1000 ms time limit and was terminated"}` |
| `output_limit` | The result was larger than `execution.maxResultBytes`, or the sandbox wrote more output than allowed. | After running (result), while running (`stdout_limit`) | `reason` (`stdout_limit`); `size`, `limit` (result) | Agent: filter, aggregate or paginate before returning. Operator: raise `execution.maxResultBytes`. | `{"type":"output_limit","name":"OutputLimitExceeded","message":"Result is 10002 bytes; the limit is 4096. Filter or aggregate before returning.","size":10002,"limit":4096}` |
| `resource_limit` | A limit other than time or result size: too many SDK calls, code, request or response too large, memory exhausted, or every execution slot busy. `reason` says which. | Before running (`code_too_large`, `executor_busy`), SDK call, while running (`memory_limit`) | `reason`; `operation` (`response_too_large`) | Agent: make fewer calls or smaller requests; retry `executor_busy` shortly. Operator: raise the matching `execution` or `upstream` limit. | `{"type":"resource_limit","reason":"max_sdk_calls","message":"More than 3 SDK calls in one execution","name":"OagMcpBrokerError"}`, `{"type":"resource_limit","reason":"memory_limit","message":"Execution exceeded the 256 MB memory limit"}` |
| `unsupported_result` | The returned value cannot be sent as JSON: a `Map`, `Set`, `BigInt`, function, symbol, `Promise`, `Error`, binary data, `NaN` or `Infinity`, an invalid `Date`, a circular reference, or nesting deeper than 64 levels. The message names where it is, with a tip. | After running | `name` | Agent: convert the value, for example with `Array.from()`, `String()` or `await`. | `{"type":"unsupported_result","name":"UnsupportedResultError","message":"Map at $; convert it with Array.from() or Object.fromEntries()"}` |
| `executor_error` | The sandbox failed for reasons unrelated to the code: Deno could not start, exited unexpectedly, or the SDK bundle lacks methods the method index lists. | Any | `name` (`BindingMismatch`) | Agent: retry once. Operator: check the operational log, the Deno installation and the host's resources. | `{"type":"executor_error","message":"Sandbox exited unexpectedly (code 1)"}` |
| `audit_unavailable` | Execution is refused because security audit records cannot be written and fail-closed auditing is on (`--audit-fail-closed` or `logging.auditFailClosed`). | Before running | None | Operator: fix the audit log destination (`logging.auditFile`). Agent: report it; retrying won't help until then. | `{"type":"audit_unavailable","message":"Execution is disabled because required security auditing is unavailable"}` |

## Reasons

`reason` narrows down `permission_denied`, `upstream_auth_error`,
`upstream_unreachable`, `resource_limit` and `output_limit`. Most refusals are
also recorded as a security audit record; the last column is the record's
`metadata.event_code`, listed in the [event catalogue](../logging.md#event-catalogue).

| Reason | Error type | Description | Audit event |
| --- | --- | --- | --- |
| `import_not_allowed` | `permission_denied` | The code imports a module (`import`, `import()` or `require`). | `execution.import_denied` |
| `sandbox_capability_denied` | `permission_denied` | The code used a capability the sandbox denies; `capability` names it. | `execution.capability_denied` |
| `authorization_denied` | `permission_denied` | The caller's `authorization` rules don't allow the operation. | `authorization.denied` |
| `network_destination_denied` | `permission_denied` | The request's method, origin or path doesn't match the operation on the configured base URL. | `network.destination_denied` |
| `invalid_url` | `permission_denied` | The request URL could not be parsed. | `network.destination_denied` |
| `redirect_denied` | `permission_denied` | The API redirected to an origin not in `upstream.allowedOrigins`. | `network.redirect_denied` |
| `unknown_binding` | `permission_denied` | A request did not come from a known SDK method. | `execution.boundary_violation` |
| `credential_not_configured` | `upstream_auth_error` | None of the operation's security schemes has credentials under `upstreamAuth.schemes`. | `credential.lookup_failed` |
| `unsupported_scheme` | `upstream_auth_error` | The operation needs a security scheme oag-mcp cannot satisfy. | `credential.lookup_failed` |
| `token_request_failed` | `upstream_auth_error` | The OAuth2 token endpoint rejected the client credentials request. | `credential.lookup_failed` |
| `token_endpoint_unreachable` | `upstream_auth_error` | The OAuth2 token endpoint could not be reached. | `credential.lookup_failed` |
| `network_error` | `upstream_unreachable` | The connection to the API failed. | None (operational `upstream.call.failed`) |
| `upstream_timeout` | `upstream_unreachable` | The API did not answer within `upstream.timeoutMs`. | None (operational `upstream.call.failed`) |
| `code_too_large` | `resource_limit` | The code is larger than `execution.maxCodeBytes`. | `execution.resource_limit` |
| `executor_busy` | `resource_limit` | `execution.maxConcurrent` executions are running and `execution.maxQueue` are waiting. | `execution.resource_limit` |
| `max_sdk_calls` | `resource_limit` | The code made more than `execution.maxSdkCalls` SDK calls. | `execution.resource_limit` |
| `request_too_large` | `resource_limit` | A request body is larger than `upstream.maxRequestBytes`. | `execution.resource_limit` |
| `response_too_large` | `resource_limit` | A response body is larger than `upstream.maxResponseBytes`. | `execution.resource_limit` |
| `memory_limit` | `resource_limit` | The sandbox ran out of its `execution.memoryMb` heap. | `execution.resource_limit` |
| `stdout_limit` | `output_limit` | The sandbox wrote more protocol output than allowed. | `execution.resource_limit` |

A `timeout` is recorded as `execution.timeout`, and a result over
`execution.maxResultBytes` or an `unsupported_result` as
`execution.resource_limit`. Every failed execution also writes an operational
`execution.failed` record with `errorType`, but never the message, code or
response body.
