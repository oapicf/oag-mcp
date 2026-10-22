#!/usr/bin/env bash
set -o errexit
set -o nounset

cd ../
npm link .
cd examples/

FIXTURES=../test/fixtures/petclinic
OUT=../stage/test-examples

printf "\n\n========================================\n"
printf "Show help guide:\n"
oag-mcp --help

printf "\n\n========================================\n"
printf "Show version info: oag-mcp --version\n"
oag-mcp --version

printf "\n\n========================================\n"
printf "Build from an existing SDK directory:\n"
oag-mcp build --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/sdk-7.26.0" \
  --out "${OUT}/petclinic-server" --force --log-level warn

printf "\n\n========================================\n"
printf "Build from a packaged SDK archive:\n"
oag-mcp build --spec "${FIXTURES}/openapi.yaml" --sdk "${FIXTURES}/petclinic-sdk-1.2.0.tgz" \
  --out "${OUT}/petclinic-server-tgz" --force --log-level warn

printf "\n\n========================================\n"
printf "Show serve usage (stdio and streamable-http):\n"
oag-mcp serve --help
