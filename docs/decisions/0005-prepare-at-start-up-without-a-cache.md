# 5. Prepare at start-up, without a persistent cache

Status: accepted, may be revisited for very large SDKs

## Context

Before serving, OAG-MCP must check the SDK, compile and bundle it for the
sandbox, produce its declarations and index its methods. This could be done
in a separate build step, or cached between runs.

## Decision

`oag-mcp serve` prepares everything each time it starts, in a private
temporary workspace that is removed when it stops. There is no separate
build command and no cache.

## Consequences

- Deploying is putting the OpenAPI document, the SDK and the configuration
  next to OAG-MCP; nothing generated needs storing, invalidating or
  protecting.
- Start-up takes one to a few seconds for a typical SDK, longer for a large one,
  and changing the spec or SDK needs a restart.
- A cache would have to be keyed on the spec, the SDK's contents, OAG-MCP's
  version and settings, and integrity-checked before its bundle runs in the
  sandbox. That cost is not worth it while preparation is fast.
