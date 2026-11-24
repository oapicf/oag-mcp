#!/usr/bin/env bash
# Start OAG-MCP with MCP Auth OAuth and Upstream Auth API key in a header,
# serving openapi.yaml and the SDK that generate-sdk.sh generated.
# Logs and security audit records go to oag-mcp.log in this folder.
set -o errexit
set -o nounset

cd "$(dirname "$0")"
: "${OAG_MCP_PRINCIPAL_ID_KEY:?Set OAG_MCP_PRINCIPAL_ID_KEY to the secret key for principal ids, at least 32 characters, e.g. openssl rand -hex 32}"
: "${PETSTORE_API_KEY:?Set PETSTORE_API_KEY to the API key}"
exec oag-mcp serve \
  --spec openapi.yaml \
  --sdk generated-sdk/ \
  --config oag-mcp.config.yaml \
  --transport streamable-http --port 3000 \
  --log-file oag-mcp.log --audit-log-file oag-mcp.log
