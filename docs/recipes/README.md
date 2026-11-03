# Recipes

Each recipe sets up OAG-MCP for one situation, from the configuration to what
you should see in the logs when it works. They build on each other, roughly
in this order.

## Getting started

| Recipe | For when you want to |
| --- | --- |
| [Read-only server](read-only.md) | Try OAG-MCP safely, with the agent able to read but not change anything. |
| [Upstream credentials](upstream-credentials.md) | Call an API that needs an API key, a bearer token or basic authentication. |
| [Upstream OAuth2](upstream-oauth.md) | Call an API that takes OAuth2 client credentials tokens. |

## Choosing what agents can do

| Recipe | For when you want to |
| --- | --- |
| [Curated operations](curated.md) | Expose only some of an API, by tag or SDK method. |
| [Per-caller permissions](per-caller-permissions.md) | Give each caller its own operations, from static bearer tokens or OAuth scopes. |
| [Execution limits](execution-limits.md) | Tune time, memory, result and API-call limits for your workload. |

## Running in production

[Deployment](../deployment.md) covers what a production server needs and how
to run it; these recipes cover its most common parts.

| Recipe | For when you want to |
| --- | --- |
| [Remote server](remote-server.md) | Serve MCP clients on other machines, over HTTPS behind a reverse proxy. |
| [Packaged SDK](packaged-sdk.md) | Deploy the SDK as a versioned `npm pack` archive. |
| [Audit logging](audit-logging.md) | Keep security audit records in their own file, a log shipper or a SIEM. |

When something does not work, [Troubleshooting](../troubleshooting.md) helps
find out why OAG-MCP does not start, a client cannot connect, or a call
failed.
