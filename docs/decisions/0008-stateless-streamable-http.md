# 8. Stateless Streamable HTTP

Status: accepted

## Context

MCP's Streamable HTTP transport allows a server to keep sessions, with a
session id carried between requests. Sessions need memory per client, and a
client must reach the same server instance for every request of its
session.

## Decision

OAG-MCP serves each HTTP request on its own: every request is authenticated
and handled by a fresh MCP server bound to that request's caller, and no
session state is kept between requests. OAG-MCP's tools need none: `search`
and `execute` each carry everything they need.

## Consequences

- Several OAG-MCP instances can run behind a load balancer without sticky
  sessions; any instance can serve any request.
- Each request is authenticated independently, so there is no session for
  a token to outlive.
- Records carry no `mcp.session.id`, and MCP features that need a session,
  such as requests from the server to the client, are not available.
- Some state is still per process: cached upstream OAuth2 tokens and the
  limit on concurrent executions apply to each instance separately.
