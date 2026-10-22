<!-- BEGIN:AVATAR -->
To be populated by generator-node node-cli-partials
<!-- END:AVATAR -->

<!-- BEGIN:BADGES -->
To be populated by generator-node node-cli-partials
<!-- END:BADGES -->

# OAG MCP

OAG MCP is a Turn OpenAPI spec and generated-SDK into code-mode MCP servers .

## Installation

```bash
npm install -g oag-mcp
```

## Usage

Create a configuration file, e.g. `oag-mcp.yaml`:

```yaml
---
text: Hello World
```

Run oag-mcp with display command:

```bash
oag-mcp display
```

Run oag-mcp with specified config file:

```bash
oag-mcp --config-file oag-mcp.yaml display
```

Run oag-mcp with specified config file and custom flags:

```bash
oag-mcp --config-file oag-mcp.yaml display --reverse true --transform upper
```

Show help guide:

```bash
oag-mcp --help
```

## Configuration

These are the configuration properties that you can use with `oag-mcp` CLI.
Some example configuration files are available on [examples](examples) folder.

| Property | Type | Description | Example |
|----------|------|-------------|---------|
| `text` | String | The message text | Hello World |

## Colophon

<!-- BEGIN:DEVELOPERS_GUIDE -->
To be populated by generator-node node-cli-partials
<!-- END:DEVELOPERS_GUIDE -->

<!-- BEGIN:BUILD_REPORTS -->
To be populated by generator-node node-cli-partials
<!-- END:BUILD_REPORTS -->
