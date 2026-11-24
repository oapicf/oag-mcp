#!/usr/bin/env bash
# Start OAG-MCP with MCP Auth none and Upstream Auth OAuth2 client credentials,
# serving openapi.yaml and the SDK that generate-sdk.sh generated.
# Logs and security audit records go to oag-mcp.log in this folder.
set -o errexit
set -o nounset

cd "$(dirname "$0")"
: "${PETSTORE_CLIENT_ID:?Set PETSTORE_CLIENT_ID to OAG-MCP's OAuth2 client id}"
: "${PETSTORE_CLIENT_SECRET:?Set PETSTORE_CLIENT_SECRET to OAG-MCP's OAuth2 client secret}"
exec oag-mcp serve \
  --spec openapi.yaml \
  --sdk generated-sdk/ \
  --config oag-mcp.config.yaml \
  --transport streamable-http --port 3000 \
  --log-file oag-mcp.log --audit-log-file oag-mcp.log
