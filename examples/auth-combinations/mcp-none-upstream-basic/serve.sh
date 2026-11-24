#!/usr/bin/env bash
# Start OAG-MCP with MCP Auth none and Upstream Auth HTTP basic,
# serving openapi.yaml and the SDK that generate-sdk.sh generated.
# Logs and security audit records go to oag-mcp.log in this folder.
set -o errexit
set -o nounset

cd "$(dirname "$0")"
: "${PETSTORE_USERNAME:?Set PETSTORE_USERNAME to the API username}"
: "${PETSTORE_PASSWORD:?Set PETSTORE_PASSWORD to the API password}"
exec oag-mcp serve \
  --spec openapi.yaml \
  --sdk generated-sdk/ \
  --config oag-mcp.config.yaml \
  --transport streamable-http --port 3000 \
  --log-file oag-mcp.log --audit-log-file oag-mcp.log
