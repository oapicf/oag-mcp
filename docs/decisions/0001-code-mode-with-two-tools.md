# 1. Code mode with two tools

Status: accepted

## Context

The usual way to expose an OpenAPI API over MCP is one tool per operation,
or one generic HTTP request tool. An API of a few hundred operations then
puts a few hundred tool definitions in the agent's context before any work
starts, and every step of a multi-call task (list, filter, look up details,
aggregate) is a separate round trip through the model, which sees and
re-decides each intermediate result.

## Decision

OAG-MCP exposes two fixed tools. `search` finds SDK methods in an index of
the API. `execute` runs TypeScript the agent writes against the generated
SDK, so a whole workflow (loops, filtering, `Promise.all`, aggregation) runs
as one program and returns only its result.

## Consequences

- The tool definitions take under a thousand tokens of context whatever the
  size of the API.
- Multi-call workflows run deterministically inside one execution instead of
  as many model turns, and intermediate data never enters the context unless
  the code returns it.
- Agents must write code, so OAG-MCP needs a sandbox
  ([ADR 2](0002-real-sdk-in-a-deno-sandbox.md)), type checking and
  structured errors that let an agent correct its code.
- Authorisation cannot be expressed as "which tools a caller sees"; it is
  applied per SDK operation inside `execute` instead.
