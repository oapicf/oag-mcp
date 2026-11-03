# 4. Bind SDK methods to operations by static analysis

Status: accepted

## Context

`search` must describe each SDK method with its OpenAPI operation, and the
broker must know which operation each SDK request belongs to. OpenAPI
Generator usually names methods after the `operationId`, but not always:
`list-pet-visits` becomes `listPetVisits`, operations without an id get a
generated name, and options change parameter shapes.

## Decision

OAG-MCP reads each SDK method's generated request code (`<method>RequestOpts`,
or `<method>Raw` in older output) for its HTTP method and path template, and
matches that to the OpenAPI operation with the same method and path. A method
that matches no operation, or several, stops start-up; the method name is
never assumed to equal the `operationId`.

## Consequences

- Bindings are exact, including for renamed and unnamed operations, and an
  SDK generated from a different document is caught at start-up
  (`SDK_SPEC_MISMATCH`).
- The analysis depends on the shape of typescript-fetch's generated code,
  which is one reason generator versions must be tested
  ([ADR 3](0003-typescript-fetch-sdks-only.md)).
- Signatures and types come from the TypeScript type checker, so `search`
  shows what the SDK really accepts.
