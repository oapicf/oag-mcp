#!/usr/bin/env bash
# Start OAG-MCP with MCP Auth static bearer and Upstream Auth HTTP bearer,
# serving openapi.yaml and the SDK that generate-sdk.sh generated.
# Logs and security audit records go to oag-mcp.log in this folder.
set -o errexit
set -o nounset

cd "$(dirname "$0")"
: "${OAG_MCP_TOKEN:?Set OAG_MCP_TOKEN to the bearer token MCP clients send, at least 16 characters}"
: "${PETSTORE_TOKEN:?Set PETSTORE_TOKEN to the API token}"
exec oag-mcp serve \
  --spec openapi.yaml \
  --sdk generated-sdk/ \
  --config oag-mcp.config.yaml \
  --transport streamable-http --port 3000 \
  --log-file oag-mcp.log --audit-log-file oag-mcp.log
