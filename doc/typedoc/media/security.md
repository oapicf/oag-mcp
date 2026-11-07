# Security

OAG-MCP lets an AI agent call a real API by writing code, so it is built on
three assumptions:

- **The agent's code is untrusted.** It may be wrong, or written to do harm
  by whoever controls the agent's input.
- **MCP callers may be remote.** Over HTTP, anyone who can reach the port
  can try to connect.
- **The API's credentials are valuable.** They must never reach the agent,
  its code, the caller or the logs.

Each of OAG-MCP's security features answers one of those:

| Feature | What it protects |
| --- | --- |
| [Authentication](#authentication) | No remote caller gets in without a valid token, every caller has an identity, and OAG-MCP proves itself to the API. |
| [Authorisation](#authorisation) | Each caller can call only the operations it is allowed. |
| [Secret handling](#secret-handling) | Credentials never leave OAG-MCP's own process. |
| [Execution sandbox](#execution-sandbox) | Agent code cannot reach the files, network, environment or processes of the host. |
| [Request broker](#request-broker) | Every API request is checked, and goes only to the configured API. |
| [Resource limits](#resource-limits) | No execution can run forever or exhaust the server. |
| [Transport protection](#transport-protection) | The MCP endpoint resists DNS rebinding, cross-site requests and leaked tokens. |
| [Safe start-up](#safe-start-up) | Preparing the SDK runs none of its code on the host, and an insecure configuration stops OAG-MCP from starting. |
| [Security audit logging](#security-audit-logging) | Every security decision is recorded, in a standard format. |

## Authentication is not authorisation

OAG-MCP keeps the two apart, each with its own configuration:

| | Authentication | Authorisation |
| --- | --- | --- |
| Question | Who is calling? And how does OAG-MCP prove itself to the API? | May this caller call this operation? |
| Configuration | `mcpAuth` and `upstreamAuth` | `authorization` |
| When | Once per stdio session, or on every HTTP request; upstream, on every SDK call | On every SDK call, and to filter `search` |
| Result | A principal; credentials on each API request | Allow or deny |
| On failure | `401` or `403` over HTTP, and nothing runs | The SDK call is refused with `permission_denied` |

Authentication hands authorisation a *principal*: the caller's id, name,
scopes and client id. Authorisation looks only at that principal and the
operation; it never sees a token, so the same rules work however the caller
authenticated. Neither is a substitute for the other: an authenticated
caller with no policy may call every operation, and a policy is only as good
as the identities it is given.

## Authentication

Authentication has two independent halves. **MCP Auth** decides who may use
OAG-MCP. Over stdio there is no credential: only the process that started
OAG-MCP can reach it, and the session runs as a principal set in the
configuration. Over Streamable HTTP, each request carries a pre-shared bearer
token or an OAuth 2.0 access token validated against your authorization
server; serving with no authentication (`mcpAuth.mode: none`) is allowed only
on a loopback address, where any local process can connect. **Upstream Auth** supplies the
credentials your API expects: API keys, basic, bearer, or OAuth2 client
credentials tokens that OAG-MCP obtains itself.

The two never mix: an MCP access token is never forwarded to the API, and
every caller reaches the API as one shared service identity.
[Authentication](authentication.md) covers both halves.

## Authorisation

Authorisation decides, for each SDK call, whether the caller may call that
operation. Rules match callers by principal, scope or client id, and
operations by SDK method, tag, HTTP method or `operationId`; a deny always
wins. Without a policy every operation is allowed, which OAG-MCP records at
start-up.

The decision is enforced by the broker on every SDK call, before credentials
are looked up, and `search` shows only what the caller may call.
[Authorisation](authorisation.md) covers the policy and where it applies.

## Secret handling

- **Only at run time.** Secrets are never accepted as command-line arguments,
  never written in the configuration file (which holds references such as
  `{ env: NAME }` or `{ secret: key }`), and never needed to prepare the SDK.
  They are resolved at start-up from environment variables or a secrets
  file, which must not be readable by group or others.
- **Only in the host process.** Credentials are added to requests by the
  broker. The sandbox's SDK is configured with the base URL and a bridge to
  the broker, nothing else, and nothing secret is written to the prepared
  workspace, the method index or the bundle.
- **Not from agent code.** Credentials the agent's code tries to supply
  itself (`Authorization`, `Cookie`, `Proxy-Authorization`, and the document's
  API key header and query names) are removed before a request is sent, and
  the removal is audited.
- **Not to other hosts.** Credentials follow redirects only to the same
  origin; a redirect to an allowed other origin is sent without them.
  `Set-Cookie` headers in responses are dropped.
- **Not in output.** Every credential OAG-MCP resolves and every token it
  obtains is scrubbed from logs, errors and tool results, as is anything
  shaped like a credential. See [Logging](logging.md#what-is-never-logged).

## Execution sandbox

Agent code never runs in OAG-MCP's own process, and `eval`, `new Function`
or `node:vm` are not used as the boundary. Each `execute` call goes through:

1. **A static check** on the host: module syntax, `import()`, `import.meta`
   and `require()` are rejected, and the code size is bounded.
2. **A type check** on the host: TypeScript is checked against the SDK's
   declarations. This catches mistakes; it is not a security boundary.
3. **A fresh Deno process** for each execution, started with:
   - no `--allow-*` flags, so the file system, network, environment,
     subprocesses, FFI and system information are all denied by Deno's
     permission model (verified by tests, including through the Node
     compatibility modules `node:fs`, `node:child_process` and
     `process.env`);
   - `--no-remote --no-npm --cached-only --no-config --no-lock`, so nothing
     is installed and no remote or npm module can be imported;
   - V8's `--disallow-code-generation-from-strings`, so `eval` and
     `new Function` throw and imports cannot be smuggled in as generated
     code;
   - `Worker` and `SharedWorker` removed before agent code runs;
   - a V8 heap limit (`execution.memoryMb`);
   - an empty environment, apart from Deno's own bookkeeping (`DENO_DIR`,
     `TMPDIR` and `HOME` pointing at a private temporary folder that is
     deleted afterwards, `DENO_NO_UPDATE_CHECK`, `DENO_NO_PROMPT`,
     `NO_COLOR`, `TZ=UTC`, and `SystemRoot` on Windows), with that folder as
     the working directory.

No state survives from one execution to the next: each gets a new process
and a new temporary folder, and nothing is writable.

## Request broker

The only way out of the sandbox is the SDK, and every request it makes goes
to the broker in OAG-MCP's own process. For each one, the broker:

- checks the caller may call the operation (see [Authorisation](#authorisation));
- checks the request matches that operation's HTTP method and path template
  on the configured `upstream.baseUrl`, after normalising the URL, and
  refuses anything else, including any URL over 8,192 characters. The path
  check takes linear time, so no path can make it slow;
- removes credentials supplied by agent code and adds the configured ones;
- handles redirects itself (unless `upstream.followRedirects` is `false`):
  same-origin ones are followed, others only to `upstream.allowedOrigins`
  and without credentials, up to `upstream.maxRedirects`;
- bounds the request and response sizes (`upstream.maxRequestBytes`,
  `upstream.maxResponseBytes`) and the time of each call
  (`upstream.timeoutMs`).

The broker treats every message from the sandbox as untrusted. Agent code
can write to the sandbox's output directly and forge request messages with
any method tag, URL, method or headers, so the broker checks each one in
full, and a forged message can do nothing a real SDK call could not
(verified by tests). A forged message is also recorded as a detection
finding, `execution.boundary_violation`.

## Resource limits

- **Time.** Each execution has a wall-clock limit (`execution.timeoutMs`,
  up to `execution.maxTimeoutMs`). At the limit, the process is killed with
  `SIGKILL` and its API requests in flight are aborted.
- **Memory.** The V8 heap is capped at `execution.memoryMb`.
- **API calls.** One execution may make at most `execution.maxSdkCalls`
  SDK calls.
- **Output.** The result (`execution.maxResultBytes`), console output
  (`execution.maxLogBytes`, and 200 entries) and the sandbox's total output
  are bounded.
- **Concurrency.** At most `execution.maxConcurrent` sandboxes run at once,
  up to `execution.maxQueue` further calls wait in arrival order, and calls
  beyond that are refused at once with `resource_limit` (`executor_busy`).
- **Request size.** An MCP request body over HTTP is limited to
  `http.maxBodyBytes`, and submitted code to `execution.maxCodeBytes`.

The [execution limits recipe](recipes/execution-limits.md) shows how to tune
them.

## Transport protection

Over **stdio**, stdout carries only MCP protocol messages, including while
the SDK is prepared at start-up, so nothing can corrupt or inject into the
protocol stream. Logs go to stderr or files.

Over **Streamable HTTP**, before a request reaches authentication:

- the `Host` header must be allowed, which defeats DNS rebinding: the
  localhost names on a loopback address, and `http.allowedHosts`;
- a browser's `Origin` must be allowed, compared exactly by scheme, host and
  port, which stops other web pages calling the server;
- a token in the URL query is refused, since URLs end up in logs and browser
  history.

OAG-MCP serves plain HTTP, binds to `127.0.0.1` by default, and refuses to
start on any other address without `mcpAuth`. For remote access, terminate
TLS in a reverse proxy. The [HTTP endpoints reference](reference/http-endpoints.md)
lists every check and response, and the
[remote server recipe](recipes/remote-server.md) shows a complete set-up.

## Safe start-up

Preparing the SDK at start-up does not weaken any of the above:

- **The SDK is read, never run, on the host.** The TypeScript compiler API
  and esbuild parse and bundle it; its code runs only inside the Deno
  sandbox, first in a start-up verification run that cannot make API calls.
  No package manager, lifecycle script or SDK build script is run, and the
  supplied SDK is never written to.
- **Archives are checked before extraction.** Entries with absolute paths,
  `..` segments, symbolic or hard links, devices or FIFOs are refused, the
  archive must have one top-level directory, and it may hold at most 20,000
  entries and 256 MiB uncompressed. It is extracted only into the private
  workspace, and every extracted path is checked to resolve inside it.
- **The workspace holds code, not secrets.** It is created with `0700`
  permissions and holds the generated code and declarations only.
- **The bundle is fixed.** It is written once, before the server is ready,
  and not rewritten while serving.

An insecure configuration stops OAG-MCP before it serves anything, with an
error code and a `security.config_invalid`,
`security.unauthenticated_nonloopback_refused` or `credential.config_invalid`
audit record. Among the refusals: `mcpAuth.mode: none` on a non-loopback
address; an OAuth issuer or token URL that is neither HTTPS nor loopback; a
secrets file readable by others; and a secret written inline instead of as a
reference. OAG-MCP never starts partially: it either passes every check or
does not serve. The [error codes reference](reference/error-codes.md) lists
them.

## Security audit logging

Every security decision is recorded as an [OCSF](https://ocsf.io/) 1.9.0
event, the schema security data lakes and SIEMs take in: callers
authenticating or being refused, the decision on every attempted SDK call,
credentials applied or removed, limits enforced, sandbox capabilities denied,
forged messages, and the security settings in force at start-up. Audit
records are written whatever the log level, and never sampled.

With `--audit-fail-closed`, `execute` stops while audit records cannot be
written, so no API call goes unaudited. [Logging](logging.md) explains the
records and their destinations, and the
[audit logging recipe](recipes/audit-logging.md) shows how to keep them.

## What is not claimed

A separate process with no Deno permissions is a strong practical boundary,
not a complete sandbox:

- **Deno and V8 vulnerabilities** could allow an escape. Keep Deno updated
  (the `deno` npm dependency is pinned; bump it with security releases), and
  run OAG-MCP as an unprivileged user, ideally in a container with no extra
  privileges and a read-only root filesystem.
- **Local JavaScript modules.** Deno does not permission-check loading local
  `.js` or `.ts` modules by absolute path. OAG-MCP blocks every route it
  knows of to a dynamic import (no `import()`, no code generation from
  strings, no workers), and JSON and text module imports are
  permission-checked; but do not keep secrets in JavaScript modules on the
  server host.
- **CPU.** Only the time limit bounds CPU; there is no per-process CPU quota.
  Use container or cgroup limits for a hard guarantee.
- **The API is reachable by design.** Within the policy, agent code can call
  any operation the caller is allowed to, as the shared service identity.
  Use [authorisation](authorisation.md) rules to restrict destructive
  operations.
- **The type check and the static import check** are defence in depth only.
- **Path parameters are opaque to the broker.** It checks requests against
  path templates, not the values in them: whether a caller may see a
  particular record is the API's decision.

## Known limitations

- Only typescript-fetch SDKs, and tested OpenAPI Generator versions and
  options.
- OpenAPI 3.0 and 3.1 only; Swagger 2.0 must be converted first.
- Upstream: no interactive OAuth flows, OpenID Connect, mTLS, digest or
  cookie API keys; one shared service identity.
- Streamable HTTP runs without sessions: server-initiated notifications and
  streams are not offered (`GET /mcp` answers `405`), and the legacy
  HTTP+SSE transport is not supported.
- Multipart and binary request bodies are passed across the bridge but are
  not yet covered by the test suite.
- No per-execution CPU quota (see above).
- No persistent preparation cache: every start prepares the SDK again,
  typically in one to a few seconds, and changes need a restart.
