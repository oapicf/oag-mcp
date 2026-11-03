# Reference

These pages list everything OAG-MCP accepts and produces: each tool, flag,
configuration property, endpoint, error and log record, with its type,
default and an example. They are for looking things up. To learn how OAG-MCP works, start
with [How it works](../how-it-works.md); to set it up for a situation, see the
[recipes](../recipes/).

| Reference | What it lists |
| --- | --- |
| [MCP tools](tools.md) | The `search` and `execute` tools: their inputs, results and limits. |
| [CLI](cli.md) | The `oag-mcp serve` command, every flag and the environment variables it reads. |
| [Configuration](configuration.md) | Every property of the configuration file, how secrets are referenced, and the authorisation patterns. |
| [HTTP endpoints](http-endpoints.md) | The paths a Streamable HTTP server answers, the checks on each request, and the responses it refuses with. |
| [Error codes](error-codes.md) | The codes OAG-MCP exits with when it cannot start, with the stage that raises each and how to fix it. |
| [Error types](error-types.md) | The errors an `execute` call can return to the agent, and the reasons that narrow them down. |
| [Log events](log-events.md) | Every operational and security audit record, its fields, the correlation ids that join them, and what redaction masks. |
