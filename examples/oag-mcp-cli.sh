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
