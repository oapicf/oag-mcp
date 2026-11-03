# 3. typescript-fetch SDKs only

Status: accepted

## Context

OpenAPI Generator has several TypeScript targets (typescript-fetch,
typescript-axios, typescript-node, typescript-angular, …), each with its own
runtime, file layout and options, and their output changes between
generator versions. OAG-MCP has to understand an SDK's code to bind its
methods to operations and to run it in the sandbox.

## Decision

OAG-MCP supports one target, typescript-fetch, from generator versions it is
tested with. It uses `fetch`, which Deno provides, and no Node.js-specific
HTTP client. SDKs from other targets, other versions or unsupported options
are refused at start-up with a specific error code;
`--allow-untested-oag-version` lets a user try an untested version.

## Consequences

- One adapter (compatibility checks and method analysis) knows the
  typescript-fetch layout; supporting another generator means adding a
  sibling adapter.
- Every new generator version needs testing before it is accepted.
- Users of other targets must generate a typescript-fetch SDK for OAG-MCP,
  even if their applications use another one.
