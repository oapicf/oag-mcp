# MCP tools reference

OAG-MCP gives MCP clients two tools: `search`, to discover the SDK's
methods, and `execute`, to run TypeScript or JavaScript that calls them in a
sandbox. This page lists each tool's inputs, its results and the limits that
apply. The agent learns the same from the tools' own descriptions, which name
the API and its SDK classes.

When a client connects, the server introduces itself with the API's title
and these instructions:

```text
Use `search` to find SDK methods (start with no arguments to browse), then `execute` TypeScript that calls them via the `sdk` binding. Return only the data you need.
```

Every result is sent twice, as structured content and as the same JSON in a
text block, so clients that read either get it. A result that reports a
failure is marked `isError: true`. Arguments that do not match a tool's input
schema, such as a `limit` of 50, are refused by the MCP layer before the
tool runs, with an `isError` text result and no structured content:

```text
Input validation error: Invalid arguments for tool execute: timeoutMs: Too small: expected number to be >=100
```

Both tools show and run only the methods the caller is allowed to call: the
[authorisation rules](configuration.md#authorisation-patterns) filter
`search`, and the broker checks every SDK call `execute` makes.

## Annotations

The tools carry MCP annotations, which clients can use to decide whether to
ask the user before a call:

| Name | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `search` | `true` | | `true` | `false` |
| `execute` | `false` | `true` | | `true` |

`execute` is marked destructive because the code it runs can call any
operation the caller is allowed, including ones that change data. To make
that untrue, allow only reading operations; see the
[read-only recipe](../recipes/read-only.md).

## search

`search` looks up SDK methods in an index built at start-up. It makes no API
calls and runs no code. What it returns depends on the arguments:

- with `id`, the full details of that one method;
- otherwise, with a non-empty `query`, the methods that best match it;
- otherwise, an overview of the API classes and their methods.

### search input

| Name | Description | Type | Mandatory | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `query` | Keywords describing what the agent wants to do, matched against method names, API classes, operation ids, summaries, descriptions, tags, paths, parameters and types. Up to 500 characters. | string | No | None: browse | `"list pets by species"` |
| `id` | A method id from an earlier result, for that method's full details. Takes priority over `query`. Up to 200 characters. | string | No | | `"PetsApi.getPetById"` |
| `tag` | Restrict a query or the overview to one API class or OpenAPI tag. When browsing, it lists all of that class's methods, up to 100. Up to 200 characters. | string | No | | `"PetsApi"`, `"owners"` |
| `limit` | The most methods a query returns, from 1 to 20. | integer | No | `5` | `10` |

### search results

A **query** returns the best-matching methods, highest score first:

```json
{
  "results": [
    {
      "id": "PetsApi.listPets",
      "sdkPath": "sdk.PetsApi.listPets",
      "signature": "listPets(requestParameters?: ListPetsRequest, initOverrides?: RequestInit | runtime.InitOverrideFunction): Promise<Array<Pet>>",
      "summary": "List pets",
      "httpMethod": "GET",
      "path": "/pets",
      "requiredArguments": [],
      "auth": "apiKeyHeader(apiKey-header) OR bearerAuth(http-bearer)",
      "score": 65.89
    }
  ],
  "total": 11,
  "hint": "Call search with { id } for full types and an example, then use execute."
}
```

| Field | Description | Type |
| --- | --- | --- |
| `results[].id` | The method id: `<ApiClass>.<method>`. | string |
| `results[].sdkPath` | How code calls it. | string |
| `results[].signature` | The method's TypeScript signature. | string |
| `results[].summary` | The operation's summary from the OpenAPI document, if it has one. | string |
| `results[].httpMethod`, `results[].path` | The HTTP method and path template of the operation. | string |
| `results[].requiredArguments` | The request parameters the call must include. | string[] |
| `results[].auth` | The credential schemes the operation accepts, or `none`. | string |
| `results[].score` | The match score; only the order matters. | number |
| `total` | How many methods matched, before `limit`. | integer |
| `hint` | What to do next. With no matches, it suggests browsing. | string |

An **id** returns one method in full, with everything needed to call it:

```json
{
  "method": {
    "id": "PetsApi.getPetById",
    "sdkPath": "sdk.PetsApi.getPetById",
    "operationId": "getPetById",
    "httpMethod": "GET",
    "path": "/pets/{petId}",
    "tags": ["pets"],
    "summary": "Get a pet by its identifier",
    "description": "Public endpoint returning a single pet, including its owner and vaccination records.",
    "signature": "getPetById(requestParameters: GetPetByIdRequest, initOverrides?: RequestInit | runtime.InitOverrideFunction): Promise<Pet>",
    "requiredArguments": ["petId"],
    "parameters": [
      { "name": "requestParameters", "type": "GetPetByIdRequest", "optional": false },
      { "name": "initOverrides", "type": "RequestInit | runtime.InitOverrideFunction", "optional": true }
    ],
    "inputType": "interface GetPetByIdRequest {\n  petId: number; // Identifier of the pet\n}",
    "returnType": "Promise<Pet>",
    "referencedTypes": [
      "interface Pet {\n  id: number;\n  name: string;\n  species: Species;\n  birthDate?: Date;\n  ownerId?: number;\n  vaccinated?: boolean;\n  weightKg?: number;\n}",
      "type Species = \"dog\" | \"cat\" | \"bird\" | \"rabbit\";"
    ],
    "apiParameters": [
      { "name": "petId", "in": "path", "required": true, "type": "integer(int64)", "description": "Identifier of the pet" }
    ],
    "responses": { "200": "The pet", "404": "Pet not found" },
    "auth": "none",
    "example": "const result = await sdk.PetsApi.getPetById({ petId: 1 });\nreturn result;"
  }
}
```

| Field | Description | Type |
| --- | --- | --- |
| `method.id`, `method.sdkPath`, `method.signature`, `method.requiredArguments`, `method.auth` | As in query results. | |
| `method.operationId` | The operation's `operationId` in the OpenAPI document, if it has one. | string |
| `method.httpMethod`, `method.path`, `method.tags` | The operation's HTTP method, path template and OpenAPI tags. | string, string, string[] |
| `method.summary`, `method.description` | From the OpenAPI document; the description is cut at 1,500 characters. | string |
| `method.deprecated` | `true` when the operation is deprecated; absent otherwise. | boolean |
| `method.parameters` | The method's parameters, with their TypeScript types. | object[] |
| `method.inputType` | The declaration of the request parameter's type. | string |
| `method.returnType` | The method's return type. | string |
| `method.referencedTypes` | Declarations of the types the input and return types use. | string[] |
| `method.apiParameters` | The operation's parameters in the OpenAPI document: where each goes (`path`, `query`, `header`, `cookie`), whether it is required, its schema type and description (cut at 300 characters). | object[] |
| `method.requestBody` | Whether a body is required, its content types and schema type, when the operation takes one. | object |
| `method.responses` | Each response status and its description. | object |
| `method.example` | Code that calls the method, ready for `execute`. | string |

An unknown id, or the id of a method the caller may not use, returns the same
error, so a caller cannot tell the two apart:

```json
{ "error": "No method with id \"PetsApi.nope\" is available. Use search with a query to find ids." }
```

**No arguments**, or only `tag`, return an overview of the API:

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
    }
  ],
  "hint": "Use search with a query or { tag: <ApiClass or tag> } to list methods; { id } for details."
}
```

| Field | Description | Type |
| --- | --- | --- |
| `api.title`, `api.version` | From the OpenAPI document's `info`. | string |
| `apis[].api` | An SDK API class. | string |
| `apis[].tags` | The OpenAPI tags of its methods. | string[] |
| `apis[].methodCount` | How many of its methods the caller may use. | integer |
| `apis[].methods` | Their ids and summaries: up to 8 per class, or up to 100 with `tag`. | object[] |
| `apis[].more` | How many methods were left out. | integer |
| `hint` | What to do next. | string |

A result over 24,000 characters is cut down: for a method's details, the
referenced types are reduced to three and `apiParameters` is dropped, and if
it is still too large it is replaced with
`{ "truncated": true, "note": "Result too large; narrow the query.", "preview": "…" }`.

## execute

`execute` runs agent code in a fresh Deno sandbox, with a global `sdk` that
exposes the SDK's API classes. Each SDK call goes from the sandbox to
OAG-MCP's broker, which checks it, adds the upstream credentials and sends it
to the API. The code returns its answer; it does not see the credentials, the
base URL or the raw HTTP traffic.

### execute input

| Name | Description | Type | Mandatory | Default | Example |
| --- | --- | --- | --- | --- | --- |
| `code` | The body of an async function: it can `await` SDK calls, loop, filter and aggregate, and `return`s the result. Up to 200,000 characters, and no larger than `execution.maxCodeBytes`. | string | Yes | | `"const pets = await sdk.PetsApi.listPets({});\nreturn pets.length;"` |
| `language` | `typescript` is type-checked against the SDK before it runs (unless `execution.typecheck` is `false`); `javascript` is not. | string | No | `typescript` | `"typescript"`, `"javascript"` |
| `timeoutMs` | The wall-clock limit for this call, in milliseconds, from 100 to 600,000. Values above `execution.maxTimeoutMs` are lowered to it. | integer | No | `execution.timeoutMs` | `60000` |

The code can use:

- `sdk.<ApiClass>.<method>(…)`, as `search` shows it;
- `console.log`, `info`, `warn`, `error` and `debug`, whose output is
  returned in `logs`;
- the JavaScript standard library.

It cannot import modules, reach the network, files, environment variables or
subprocesses, generate code from strings, or start workers. Each call runs in
a new process, so nothing carries over from one call to the next.
[Security](../security.md#execution-sandbox) describes the sandbox.

### execute result

```json
{
  "ok": true,
  "executionId": "exec_9af3b163-aa48-47a8-b782-0e2be91e1dff",
  "result": [
    { "id": 1, "name": "Biscuit" },
    { "id": 2, "name": "Mochi" }
  ],
  "logs": [{ "level": "log", "message": "got 12" }],
  "logsTruncated": false,
  "stats": { "durationMs": 848, "sdkCalls": 1 }
}
```

| Field | Description | Type | Present |
| --- | --- | --- | --- |
| `ok` | Whether the call succeeded. | boolean | Always |
| `executionId` | The id of this call, also in every log record about it. | string | Always |
| `result` | The value the code returned, as JSON. At most `execution.maxResultBytes`. | any | When `ok` is `true` and the code returned a value |
| `logs` | The console output, in order: each entry's `level` (`log`, `info`, `warn`, `error` or `debug`) and `message`. | object[] | Always |
| `logsTruncated` | Whether console output was dropped: beyond `execution.maxLogBytes` or 200 entries. | boolean | Always |
| `error` | What went wrong; `type` is one of the [error types](error-types.md). | object | When `ok` is `false` |
| `hint` | Advice for the agent: that the code returned nothing, or that an error came from inside the SDK rather than the code. | string | Sometimes |
| `stats.durationMs` | How long the call took, in milliseconds. | integer | Always |
| `stats.sdkCalls` | How many SDK calls the code made. | integer | Always |

A failed call keeps the same shape, with `ok: false` and an `error`:

```json
{
  "ok": false,
  "executionId": "exec_56c52c1d-7ad7-4cb5-875b-6c011cedc1ae",
  "logs": [],
  "logsTruncated": false,
  "error": {
    "type": "api_error",
    "name": "ResponseError",
    "message": "The API responded with HTTP 404 Not Found",
    "status": 404,
    "body": "{\"code\":\"not_found\",\"message\":\"pet 404 not found\"}",
    "line": 1,
    "column": 15
  },
  "stats": { "durationMs": 71, "sdkCalls": 1 }
}
```

### Result values

The returned value must be JSON-compatible. A `Date` becomes an ISO 8601
string, and `undefined` properties are left out (`null` in arrays). `Map`,
`Set`, `BigInt`, functions, symbols, typed arrays, `Blob`, a `Promise` (a
missing `await`), `Error`, non-finite numbers and circular structures are
refused with `unsupported_result` and a hint. Binary responses reach the code
as `Blob`s, and must be converted before they are returned.

The limits on each call are set in the `execution` section of the
configuration: time, memory, code size, result size, console output and the
number of SDK calls, plus how many calls run at once. See the
[configuration reference](configuration.md) and the
[execution limits recipe](../recipes/execution-limits.md).
