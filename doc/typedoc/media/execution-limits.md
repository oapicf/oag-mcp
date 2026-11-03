# Execution limits

Every `execute` call runs the agent's code in a fresh sandbox with limits on
time, memory, output and API traffic. The defaults suit an agent making a
handful of calls and returning a summary. This recipe adjusts them: looser
for heavy reporting work, tighter for a shared server, and explains what the
agent sees when it reaches one.

Limits protect three things: the machine OAG-MCP runs on (memory, CPU time,
concurrency), the API it calls (calls per execution, request and response
sizes), and the agent's context window (result and log sizes). A limit that
is reached ends the call with a structured error that tells the agent what to
change, and is recorded as an `execution.resource_limit` or
`execution.timeout` audit record.

## The limits

| Setting | Default | Limits | When reached |
| --- | --- | --- | --- |
| `execution.timeoutMs` | `30000` | Wall-clock time of one call, when the call does not set its own. | `timeout`; the sandbox is killed |
| `execution.maxTimeoutMs` | `120000` | The highest `timeoutMs` a call may ask for. Larger requests are lowered to it. | (caps `timeoutMs`) |
| `execution.memoryMb` | `256` | The sandbox's JavaScript heap. | `resource_limit` / `memory_limit` |
| `execution.maxSdkCalls` | `200` | SDK calls in one execution. | `resource_limit` / `max_sdk_calls` |
| `execution.maxResultBytes` | `65536` | The size of the returned value, as JSON. | `output_limit` |
| `execution.maxLogBytes` | `16384` | Console output kept from one call. | Not an error: the result says `logsTruncated: true` |
| `execution.maxCodeBytes` | `100000` | The submitted code. | `resource_limit` / `code_too_large`, before running |
| `execution.maxConcurrent` | `4` | Executions running at once. | Further calls wait in the queue |
| `execution.maxQueue` | `16` | Executions waiting for a free slot. | `resource_limit` / `executor_busy` |
| `upstream.timeoutMs` | `15000` | Time for the API to answer one SDK call. | `upstream_unreachable` / `upstream_timeout` |
| `upstream.maxResponseBytes` | `5242880` (5 MiB) | One API response body. | `resource_limit` / `response_too_large` |
| `upstream.maxRequestBytes` | `1048576` (1 MiB) | One request body sent to the API. | `resource_limit` / `request_too_large` |

The [configuration reference](../reference/configuration.md) gives each
setting's allowed range, and the [error types reference](../reference/error-types.md)
each error.

## Choosing values

**Time.** `execution.timeoutMs` must cover the slowest API calls an execution
makes in sequence; `upstream.timeoutMs` the slowest single call. Agents may
pass `timeoutMs` with an `execute` call for a longer job; `maxTimeoutMs` caps
what they can ask for. Keep `upstream.timeoutMs` below `execution.timeoutMs`,
so a slow API produces an `upstream_timeout` naming the operation, rather
than the whole execution timing out.

**Memory and concurrency together.** Each running execution is a separate
sandbox process with up to `memoryMb` of heap, so the machine needs at least
`maxConcurrent × memoryMb` (1 GB with the defaults), plus the memory each
sandbox runtime and OAG-MCP itself use beyond that. In a container, set its
memory limit with room to spare above that, or lower `maxConcurrent`.

**Results.** `maxResultBytes` is the most important limit for agent quality:
a large result fills the agent's context window. Keep it small and let the
limit's message (`Filter or aggregate before returning.`) teach the agent to
return only what it needs. Raise it only when callers genuinely need bulk
data in one result.

**API traffic.** `maxSdkCalls` stops a runaway loop from flooding the API.
Set it from the largest legitimate job: an execution that pages through 500
records 50 at a time needs at least 10.

## Configurations

For a single user's heavy reporting, with long-running jobs:

```yaml
execution:
  timeoutMs: 60000          # one minute by default
  maxTimeoutMs: 300000      # up to five minutes when asked for
  memoryMb: 512
  maxConcurrent: 2          # 2 × 512 MB of heap
  maxSdkCalls: 1000
  maxResultBytes: 262144    # 256 KiB
upstream:
  timeoutMs: 30000
```

For a shared server with many callers and short tasks:

```yaml
execution:
  timeoutMs: 15000
  maxTimeoutMs: 30000
  memoryMb: 128
  maxConcurrent: 8          # 8 × 128 MB of heap
  maxQueue: 32
  maxSdkCalls: 50
  maxResultBytes: 32768     # 32 KiB
upstream:
  timeoutMs: 5000
```

## What the agent and the logs show

The examples below come from OAG-MCP with deliberately small limits, so that
each is easy to reach:

```yaml
upstream:
  timeoutMs: 1000
  maxResponseBytes: 1024
execution:
  timeoutMs: 2000
  maxTimeoutMs: 3000
  memoryMb: 64
  maxSdkCalls: 3
  maxResultBytes: 2048
  maxLogBytes: 256
  maxCodeBytes: 2000
```

| The agent's code | Error the agent receives | Records |
| --- | --- | --- |
| `while (true) {}`, with `timeoutMs: 10000` | `timeout`: `Execution exceeded the 3000 ms time limit and was terminated` (the request was lowered to `maxTimeoutMs`) | `execution.timeout`, `executor.terminated` |
| A loop that keeps allocating strings | `resource_limit` / `memory_limit`: `Execution exceeded the 64 MB memory limit` | `execution.resource_limit` (`memoryMb`) |
| Five `getPetById` calls | `resource_limit` / `max_sdk_calls`: `More than 3 SDK calls in one execution` | `execution.resource_limit` (`maxSdkCalls`) |
| `return "x".repeat(5000)` | `output_limit`: `Result is 5002 bytes; the limit is 2048. Filter or aggregate before returning.` | `execution.resource_limit` (`output_limit`) |
| 100 `console.log` lines | None: the call succeeds with 17 log lines and `logsTruncated: true` | None |
| A call to an endpoint that takes 2.5 s | `upstream_unreachable` / `upstream_timeout`: `The API did not respond within 1000 ms` | operational `upstream.call.failed` |
| `listPets` returning 1.3 KB | `resource_limit` / `response_too_large`: `The API response exceeded 1024 bytes` | `execution.resource_limit` (`maxResponseBytes`) |
| 2.1 KB of code | `resource_limit` / `code_too_large`: `Code is 2113 bytes; the limit is 2000` | `execution.resource_limit` (`maxCodeBytes`) |

The calls that completed before a limit was reached still happened: the
fourth `getPetById` was refused, but the first three reached the API. Each
error's `stats.sdkCalls` says how many calls the execution made, so the agent
can tell what has already been done.

With `maxConcurrent: 1` and `maxQueue: 1`, three executions sent at once,
each taking 1.5 seconds, go like this:

| Call | Outcome | Duration |
| --- | --- | --- |
| First | Runs at once | 1.8 s |
| Second | Waits for the first, then runs | 3.3 s |
| Third | Refused: `resource_limit` / `executor_busy`, `Too many concurrent executions; retry shortly` | 0.06 s |

An `executor_busy` call never started, so the agent can safely retry it.

A limit's audit record names the setting that was reached and its value, for
example:

```json
{
  "class_name": "API Activity",
  "activity_name": "Execute",
  "severity": "Low",
  "status": "Failure",
  "metadata": { "event_code": "execution.resource_limit", "…": "…" },
  "actor": { "user": { "uid": "local:local" } },
  "unmapped": { "limit": "maxConcurrent", "value": 1 },
  "message": "execution.resource_limit"
}
```

To find which limits callers reach most often, count them:

```bash
jq -r 'select(.metadata.event_code == "execution.resource_limit") | .unmapped.limit' oag-mcp.log | sort | uniq -c
```

A limit reached often by legitimate work is set too low; one reached by a
few callers, or after a change to the agent, is doing its job.
