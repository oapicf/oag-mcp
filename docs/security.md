# Execution sandbox and limits

Agent code is untrusted. It never runs in the MCP server's own process, and
`eval`, `new Function` or `node:vm` are not used as the boundary.

## What is enforced

Each `execute` call:

1. **Static policy** (host): module syntax, `import()`, `import.meta` and
   `require()` are rejected; code size is bounded.
2. **Type check** (host): TypeScript is checked against the SDK declarations.
   This is a correctness feature, not an authorization boundary.
3. **Fresh Deno process** per execution, started with:
   - no `--allow-*` flags: filesystem read/write, network, environment,
     subprocess, FFI and system information are all denied by Deno's
     permission model (verified by tests, including via Node-compat
     `node:fs`/`node:child_process` and `process.env`);
   - `--no-remote --no-npm --cached-only --no-config --no-lock`: no package
     installation, remote or npm imports;
   - V8 `--disallow-code-generation-from-strings`: `eval`/`new Function` throw,
     so imports cannot be smuggled through generated code;
   - `Worker`/`SharedWorker` removed before agent code runs;
   - a V8 heap limit (`execution.memoryMb`);
   - an empty environment except Deno bookkeeping (`DENO_DIR`, `TMPDIR`,
     `HOME` pointing at a private temporary directory that is deleted
     afterwards, `NO_COLOR`, `TZ=UTC`), and that directory as the working
     directory.
4. **Host broker** for all HTTP traffic: per-operation authorization, request
   must match the operation's method and path template on the configured base
   URL (after URL normalisation), credential injection, manual redirect
   handling, bounded request/response sizes, per-call timeouts, `maxSdkCalls`.
5. **Wall-clock timeout**: the process is killed with `SIGKILL`; in-flight
   upstream requests are aborted.
6. **Bounded output**: result size (`maxResultBytes`), console capture
   (`maxLogBytes`, 200 entries), total sandbox stdout.
7. **Isolation between executions**: no state survives (new process, new
   temporary directory, nothing writable).
8. **Concurrency**: `maxConcurrent` sandboxes with a bounded queue.

Violations produce structured errors (`permission_denied` with `capability`
or `reason`, `timeout`, `output_limit`, `resource_limit`) and
`security_audit` log records.

## Result serialisation

Results must be JSON-compatible. `Date` becomes an ISO string; `undefined`
properties are omitted (and `null` in arrays). `Map`, `Set`, `BigInt`,
functions, symbols, typed arrays, `Blob`, `Promise` (missing `await`),
`Error`, non-finite numbers and circular structures are rejected with
`unsupported_result` and a hint. Responses that are binary are available to
code as `Blob`s but must be converted before returning.

## What is NOT claimed

Process separation plus Deno permissions is a strong practical boundary,
not a complete sandbox:

- **Deno/V8 vulnerabilities** could allow escape. Keep Deno updated (the
  `deno` npm dependency is pinned; bump it with security releases) and run
  oag-mcp as an unprivileged user, ideally in a container with no extra
  privileges or a read-only root filesystem.
- **Local JavaScript modules**: Deno does not permission-check loading local
  `.js`/`.ts` *modules* by absolute path. oag-mcp blocks every route it knows
  to issue a dynamic import (static `import()` rejection, no string code
  generation, no workers), and JSON/text module imports *are* read-permission
  checked; but do not keep secrets in JavaScript modules on the server host.
- **CPU and wall-clock**: only the timeout bounds CPU; there is no per-process
  CPU quota. Use container/cgroup limits for hard guarantees.
- **The upstream API is reachable by design**: within the policy, agent code
  can call any operation the principal is allowed to call, with the shared
  service identity. Use `authorization` rules to restrict destructive
  operations.
- **Type checking and the static import check** are defence in depth only.
- The broker validates requests against path templates; path parameters
  are opaque to it (e.g. an id the principal should not see is the API's
  responsibility).

## Known limitations

- Only typescript-fetch SDKs and tested OpenAPI Generator versions/options.
- OpenAPI 3.0/3.1 only (Swagger 2.0 must be converted first).
- Upstream: no interactive OAuth flows, OpenID Connect, mTLS, digest or
  cookie API keys; one shared service identity.
- Streamable HTTP runs stateless: server-initiated notifications/SSE
  streams are not offered (`GET /mcp` returns `405`). Legacy HTTP+SSE is not
  supported.
- Multipart and binary request bodies are serialised across the bridge but
  are not covered by the test suite yet.
- No per-execution CPU quota (see above).
