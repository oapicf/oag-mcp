# How it works

`oag-mcp serve` is one process that works in two phases. When it starts, it
reads the OpenAPI document and the SDK once and prepares everything it needs
in memory. It then serves MCP clients for as long as it runs, answering every
`search` and `execute` call from that preparation. This page follows the
sequence from the moment the command starts to the moment it stops.

Each step stays at the level of what happens and why. The detail lives in the
pages linked from each step: [Architecture](architecture.md) for the
components, [Security](security.md) for the sandbox,
[Authentication](authentication.md) for callers and credentials, and
[Logging](logging.md) for the records each step writes.

Because preparation happens once, the inputs are fixed for the life of the
process. After regenerating the SDK, editing the OpenAPI document or changing
the configuration, restart oag-mcp.

## Starting up

### 1. Read the command line and the configuration

oag-mcp first checks the command line: `--spec` and `--sdk` are required,
values such as `--transport` must be one of the allowed choices, and
`--port` must be in range. A mistake stops it here with a short message,
before anything else happens. The [CLI reference](reference/cli.md) lists
every flag.

It then reads the configuration file given with `--config`, if any, and
validates every property, refusing unknown ones so that a typo cannot be
silently ignored. Every problem in the file is reported at once. Without
`--config`, the built-in defaults apply. The flags `--host`, `--port`,
`--path` and the logging flags override the file.

With the configuration known, oag-mcp opens its log destinations, stderr by
default, and installs handlers for `SIGINT` and `SIGTERM`, so that from here
on a stop request is handled cleanly, even during start-up. The first log
record, `cli.command.started`, is written.

### 2. Read the OpenAPI document and the SDK

oag-mcp loads the OpenAPI document, in YAML or JSON, and checks that it is a
valid OpenAPI 3.0 or 3.1 document. Only references within the document are
followed: oag-mcp does not fetch anything from the network to read it.

It then finds the SDK. A folder is used where it is, and only read: oag-mcp
never writes to it, never installs packages into it and never runs its
scripts. An `npm pack` archive is extracted into a private temporary folder,
the *workspace*, which oag-mcp creates for this process and removes when it
stops.

From here on, preparation runs as a series of stages, each logged with its
duration (`prepare.stage.completed`). If any stage fails, oag-mcp logs which
one, removes the workspace and exits with an [error code](reference/error-codes.md) and a hint: it never
starts a partially working server. [Troubleshooting](troubleshooting.md)
lists the common errors.

### 3. Check the SDK is compatible

oag-mcp supports SDKs from OpenAPI Generator's typescript-fetch generator, so
it checks that the SDK is one: its runtime files, the generator version
recorded in `.openapi-generator/VERSION`, the generator options it was made
with, and its layout, TypeScript sources (`src/*.ts`) or a compiled package
(`dist/*.js` with `.d.ts` declarations).

It also checks that any runtime dependencies the SDK declares are already
installed next to it. oag-mcp does not install them; if one is missing,
start-up stops with `SDK_DEPENDENCIES_MISSING`, naming the packages to
install (`npm install --omit=dev --ignore-scripts` in the SDK folder).

An SDK that fails a check is refused with a code saying why, such as an
untested generator version or an unsupported option.
[SDK compatibility](sdk-compatibility.md) lists what is supported, and
[Packaged SDK](recipes/packaged-sdk.md) covers versions and layouts.

### 4. Prepare the SDK for the sandbox

Agent code will run the real SDK, inside a sandbox, so oag-mcp prepares a
copy the sandbox can load: one JavaScript bundle containing the SDK and
everything it needs. Sources are compiled first; a compiled package is used
as it is.

It also produces the SDK's TypeScript declarations, its classes, methods and
models as types. These are what agent code is type-checked against before it
runs, and what `search` shows the agent.

Both are written to the workspace. Nothing in it is secret, since
credentials are not involved yet, and nothing in it outlives the process:
there is no cache to manage, and preparation of a typical SDK takes one to a
few seconds.

### 5. Index the SDK's methods

oag-mcp now connects the two inputs. It reads each SDK method's generated
code to find the HTTP method and path it calls, and matches that to the
operation in the OpenAPI document. A method's name is never assumed to equal
the operation's `operationId`; an SDK method that matches no operation, or
several, stops start-up rather than being guessed.

Each match becomes a *method record*: the SDK method's exact signature and
types, merged with the OpenAPI operation's summary, description, tags,
parameters and security requirements, plus a ready-to-run example. The
records go into an in-memory full-text index.

This index is what `search` answers from, and the binding ids it holds, such
as `PetsApi.listPetVisits`, are what the agent calls and what
[authorization rules](recipes/curated.md) select. The log record
`prepare.index.created` gives the number of methods.

### 6. Set up credentials, policy and the sandbox

oag-mcp resolves the upstream credentials configured for each security
scheme, reading environment variables and the secrets file. A missing one
stops start-up now, before any client connects, rather than failing on the
first call. OAuth2 tokens are not requested yet: they are obtained when a
call first needs one. See [Upstream credentials](recipes/upstream-credentials.md).

It loads the authorization policy, which decides which operations each
caller may use, and builds the *request broker*: the part of oag-mcp,
outside the sandbox, through which every SDK request will pass. It then finds
the Deno runtime that runs the sandbox, and starts it once with the prepared
bundle to verify that every SDK method in the index is present.

Each of these is recorded in the security audit log
(`credential.provider.configured`, `authorization.policy_loaded`,
`execution.policy.applied`), so the settings in force are on record from the
start. Credentials themselves are never logged.

### 7. Open the transport

oag-mcp registers its two tools, `search` and `execute`, whose descriptions
are computed once from the index. Then it starts the transport. With stdio,
the default, it reads MCP messages from stdin and writes responses to stdout,
which carries nothing else, not even logs.

With Streamable HTTP, it listens on the configured address, `127.0.0.1` by
default. On any other address it refuses to start unless MCP authentication
(`mcpAuth`) is configured, and it warns that HTTPS must come from a proxy in
front of it. See [Remote server](recipes/remote-server.md).

The `server.ready` record marks the end of start-up, with its total duration;
for HTTP, oag-mcp also prints `oag-mcp listening on <url>` to stderr. From
now on it serves MCP clients.

## Serving a call

### 8. Identify the caller

Every tool call has a caller, a *principal*, that authorization rules and
audit records refer to. Over stdio, the caller is whoever started the
process, named by `mcpAuth.stdio.principal`.

Over Streamable HTTP, every request is checked: its `Host` and `Origin`
headers against `http.allowedHosts` and `http.allowedOrigins`, and its bearer
token, static or OAuth, according to `mcpAuth`. A request that fails is
answered with `401`, `403` or `400` and never reaches the tools.

Each check is audited (`authentication.succeeded`, `authentication.failed`,
`transport.host_rejected`, …). The caller's token is used only to identify
the caller: it is never passed on to the API. See
[Authentication](authentication.md) and
[Per-caller permissions](recipes/per-caller-permissions.md).

### 9. Answer `search`

`search` answers from the in-memory index, without running code or calling
the API. With no arguments it lists the API classes and their methods; with a
`query` it returns the best matches; with an `id` it returns one method in
full:

```jsonc
{ }                                   // browse
{ "query": "vet visits of a pet" }    // ranked full-text search
{ "id": "PetsApi.listPetVisits" }     // full detail
```

A detail result gives the agent what it needs to call the method correctly
(abridged):

```json
{
  "method": {
    "id": "PetsApi.listPetVisits",
    "sdkPath": "sdk.PetsApi.listPetVisits",
    "operationId": "list-pet-visits",
    "httpMethod": "GET",
    "path": "/pets/{petId}/visits",
    "signature": "listPetVisits(requestParameters: ListPetVisitsRequest, initOverrides?: RequestInit | runtime.InitOverrideFunction): Promise<Array<Visit>>",
    "requiredArguments": ["petId"],
    "auth": "apiKeyHeader(apiKey-header) OR bearerAuth(http-bearer)",
    "example": "const result = await sdk.PetsApi.listPetVisits({ petId: 1 });\nreturn result;"
  }
}
```

Results are filtered by the caller's permissions: a method the caller may not
call is not listed, and asking for it by id gets the same answer as for a
method that does not exist.

### 10. Check `execute` code before running it

The agent sends the body of an async function, with the SDK available as
`sdk`:

```ts
const pets = await sdk.PetsApi.listPets({});
const unvaccinated = pets.filter((p) => !p.vaccinated);
const visits = await Promise.all(
  unvaccinated.map((p) => sdk.PetsApi.listPetVisits({ petId: p.id })),
);
return unvaccinated.map((p, i) => ({
  pet: p.name,
  spentCents: visits[i].reduce((s, v) => s + (v.costCents ?? 0), 0),
}));
```

Before anything runs, oag-mcp records the request in the audit log, refusing
it if fail-closed auditing is on and the audit log cannot be written. It then
checks the code: within the size limit, free of imports, and valid
TypeScript or JavaScript. TypeScript is also type-checked against the SDK's
declarations, so a misspelt method or a wrong argument comes back as a
`type_error` with line numbers, without a single API call.

Finally the call waits for a free sandbox slot, up to
`execution.maxConcurrent` running at once; if the queue is full too, it is
refused as busy. A call refused at this step has had no effect, so the agent
can fix the code and try again.

### 11. Run the code in the sandbox

Each call gets a new sandbox: a separate Deno process with no permissions at
all. It cannot read or write files, open network connections, read
environment variables or start programs, and `eval` is disabled. It
inherits none of oag-mcp's environment variables, and its memory is capped.
See [Security](security.md).

Inside it, the agent's code runs against the real SDK from step 4, so request
building, parameter serialisation and response parsing are the SDK's own. The
one thing replaced is the SDK's `fetch`: instead of reaching the network, each
request is handed to the request broker in oag-mcp.

The sandbox is killed when the call ends, or when it reaches its time limit.
The time, memory and other limits are in
[Execution limits](recipes/execution-limits.md).

### 12. Pass each SDK request through the broker

Every request the SDK makes arrives at the broker, outside the sandbox, tagged
with the SDK method that made it. The broker first checks the caller may use
that operation, under the authorization policy, and that the request matches
the operation's method and path on the configured API. Anything else is
refused and never sent.

It then removes any credentials the agent's code added itself, and applies
the configured credentials the operation's security requirement calls for,
obtaining an OAuth2 token if one is needed. The agent never sees a credential;
it only sees the result.

The broker sends the request, follows redirects only to allowed origins, and
returns the response to the sandbox within its size limit. Each decision is
audited, `authorization.allowed` or `authorization.denied` among others, and
each response logged with its status and duration, never its body.

### 13. Return the result

When the code returns, its value is converted to JSON and returned to the
agent, together with what the code wrote to the console and statistics. Known
secrets are scrubbed from all of it, in case the API echoed one back:

```json
{
  "ok": true,
  "result": [
    { "pet": "Biscuit", "spentCents": 8100 },
    { "pet": "Nori", "spentCents": 8400 }
  ],
  "logs": [],
  "stats": { "durationMs": 131, "sdkCalls": 5 }
}
```

If something went wrong, the result has `ok: false` and an `error` whose
`type` says what: an API error with its status and body, a refused operation,
a limit reached, an exception in the code. An exception thrown inside the SDK
rather than the agent's code names the SDK function in `thrownIn`, a sign
that the API's response does not match the OpenAPI document. The
[error types reference](reference/error-types.md) describes each.

Every call ends with an `execution.completed` or `execution.failed` record,
and its `executionId` ties together every record about it, as
[Troubleshooting](troubleshooting.md) shows. Agent code, results and bodies
are never logged.

## Stopping

### 14. Shut down cleanly

oag-mcp stops on `SIGINT` or `SIGTERM`, or, over stdio, when the client closes
stdin. It stops the transport, flushes its logs, and removes the workspace
with everything prepared in it.

A stop request during start-up cancels preparation at the next stage and
removes the workspace too. A second request exits at once.

If the process is killed without warning, with `SIGKILL` or `SIGHUP`, the
workspace is left behind; the next start on the same machine removes it. See
[Deployment](deployment.md) for temporary files and running in production.
