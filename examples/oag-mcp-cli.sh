#!/usr/bin/env bash
set -o errexit
set -o nounset

cd ../
npm link .
cd examples/

FIXTURES=../test/fixtures/petclinic

printf "\n\n========================================\n"
printf "Show help guide:\n"
oag-mcp --help

printf "\n\n========================================\n"
printf "Show version info: oag-mcp --version\n"
oag-mcp --version

printf "\n\n========================================\n"
printf "Show serve usage (stdio and streamable-http):\n"
oag-mcp serve --help

# With stdin closed, the stdio server prepares the SDK, reports readiness and
# shuts down straight away (removing its temporary workspace): a quick way to
# check that a spec and SDK can be served. Logs go to stderr.
printf "\n\n========================================\n"
printf "Serve directly from an existing SDK directory:\n"
oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/sdk-7.26.0" \
  --transport stdio --log-format pretty </dev/null

printf "\n\n========================================\n"
printf "Serve directly from a packaged SDK archive (compiled JavaScript):\n"
oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/petclinic-sdk-1.2.0.tgz" \
  --sdk-layout compiled --transport stdio --log-level warn </dev/null

# The example configurations refer to secrets by environment variable and, for
# the admin password, by key in a secrets file. These are placeholders: start-up
# only needs the secrets to exist, and nothing below calls the API.
export API_KEY=example-api-key API_TOKEN=example-api-token ADMIN_USER=clinic-admin
export CLIENT_ID=example-client-id CLIENT_SECRET=example-client-secret
export MCP_TOKEN=example-mcp-token-0123456789
export SUPPORT_BOT_TOKEN=example-support-bot-token CLINIC_OPS_TOKEN=example-clinic-ops-token
export PETCLINIC_API_KEY=example-api-key PETCLINIC_TOKEN=example-api-token
export PETCLINIC_ADMIN_USER=clinic-admin
export PETCLINIC_CLIENT_ID=example-client-id PETCLINIC_CLIENT_SECRET=example-client-secret
export OAG_MCP_READER_TOKEN=example-reader-token-0123 OAG_MCP_ADMIN_TOKEN=example-admin-token-0123
trap 'rm -f secrets.yaml' EXIT
printf "admin_password: example-admin-password\n" > secrets.yaml
chmod 600 secrets.yaml

mkdir -p ../stage/test-examples/

# Each configuration is checked the same way as above: with stdin closed, the
# stdio server prepares the SDK with the configuration applied, reports
# readiness, and shuts down. A configuration error stops it with an error code.
for recipe in read-only upstream-credentials upstream-oauth curated \
  per-caller-permissions execution-limits; do
  printf "\n\n========================================\n"
  printf "Serve with the %s recipe's configuration:\n" "${recipe}"
  oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/sdk-7.26.0" \
    --transport stdio --config "oag-mcp-${recipe}.config.yaml" --log-format pretty --log-level warn </dev/null
done

printf "\n\n========================================\n"
printf "Serve with the general example configuration:\n"
oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/sdk-7.26.0" \
  --transport stdio --config oag-mcp.config.yaml --log-format pretty --log-level warn </dev/null

printf "\n\n========================================\n"
printf "Serve a packaged SDK archive with the packaged-sdk recipe's configuration:\n"
oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/petclinic-sdk-1.2.0.tgz" \
  --transport stdio --config oag-mcp-packaged-sdk.config.yaml --log-format pretty --log-level warn </dev/null

# The configuration names /var/log/oag-mcp/; the flags override it, so the
# records land in stage/test-examples/ instead.
printf "\n\n========================================\n"
printf "Serve with the audit-logging recipe's configuration, audit records to their own file:\n"
rm -f ../stage/test-examples/operational.log ../stage/test-examples/audit.log
oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/sdk-7.26.0" \
  --transport stdio --config oag-mcp-audit-logging.config.yaml \
  --log-file ../stage/test-examples/operational.log \
  --audit-log-file ../stage/test-examples/audit.log --log-format pretty </dev/null
printf "Audit records written: "
wc -l <../stage/test-examples/audit.log

# The remote server runs until it is stopped, so start it in the background,
# check it, then stop it. --host keeps it on loopback for this run; health
# checks and clients send the public Host name that http.allowedHosts names.
printf "\n\n========================================\n"
printf "Serve over Streamable HTTP with the remote-server recipe's configuration:\n"
oag-mcp serve --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/sdk-7.26.0" \
  --transport streamable-http --host 127.0.0.1 --port 3901 \
  --config oag-mcp-remote-server.config.yaml --log-format pretty --log-level warn </dev/null &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl --silent --output /dev/null --header "Host: mcp.example.com" \
    http://127.0.0.1:3901/healthz && break
  sleep 1
done
HEALTH=$(curl --silent --header "Host: mcp.example.com" http://127.0.0.1:3901/healthz)
printf "Health check: %s\n" "${HEALTH}"
STATUS=$(curl --silent --output /dev/null --write-out "%{http_code}" --request POST \
  --header "Host: mcp.example.com" --header "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:3901/mcp)
printf "MCP request without a token: HTTP %s\n" "${STATUS}"
kill -TERM "${SERVER_PID}"
wait "${SERVER_PID}"
