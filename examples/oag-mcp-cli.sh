#!/usr/bin/env bash
set -o errexit
set -o nounset

cd ../
npm link .
cd examples/

printf "\n\n========================================\n"
printf "Show help guide:\n"
oag-mcp --help

printf "\n\n========================================\n"
printf "Show version info: oag-mcp --version\n"
oag-mcp --version

printf "\n\n========================================\n"
printf "Run command with default config file:\n"
oag-mcp display

printf "\n\n========================================\n"
printf "Run command with specified config file:\n"
oag-mcp --config-file oag-mcp.yaml display

printf "\n\n========================================\n"
printf "Run command with specified config file and custom flags:\n"
oag-mcp --config-file oag-mcp.yaml display --reverse true --transform upper
