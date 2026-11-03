# 2. The real SDK in a Deno sandbox, with a host broker

Status: accepted

## Context

`execute` runs code written by an agent, which must be treated as untrusted:
it may be wrong, or steered by injected instructions. That code needs the
SDK, and the SDK needs credentials and network access to reach the API. The
credentials must never be readable by the code.

## Decision

Each execution runs in a separate Deno process with no permissions: no
files, network, environment, subprocesses or `eval`. The real generated SDK
runs inside it, so request building, serialisation and response parsing are
the SDK's own. Only the SDK's `fetch` is replaced: each request is sent as a
message to a broker in the OAG-MCP process, which authorises the operation,
checks the destination, applies credentials and makes the call.

Alternatives considered:

- **Run the SDK on the host and proxy method calls from the sandbox.** Keeps
  the SDK out of the sandbox, but means serialising SDK arguments (dates,
  blobs) across the boundary, and running the supplied SDK's code in the
  server process. The chosen split gives the same credential isolation with
  less machinery.
- **Give the sandbox `--allow-net=<api host>` and the credentials.** Simplest,
  but credentials would be readable by agent code.
- **`node:vm`, `isolated-vm` or QuickJS/WebAssembly.** `node:vm` is not a
  security boundary; isolated-vm and QuickJS would need a custom bridge for
  fetch, timers and the SDK's globals, and are less proven with this SDK's
  runtime. Deno gives a separate process, a permission model, and the
  standard web runtime the SDK already targets.

## Consequences

- Credentials, the configuration and the network exist only on the host
  side; the broker is the single place where requests are checked and
  audited.
- Each execution pays for starting a process, tens of milliseconds, and the
  SDK must load without Node.js built-ins.
- Deno is a runtime dependency, shipped through the `deno` npm package.
- The executor sits behind an `Executor` interface, so another sandbox could
  replace Deno without changing the tools.
