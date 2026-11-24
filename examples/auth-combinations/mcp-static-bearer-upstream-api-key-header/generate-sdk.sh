#!/usr/bin/env bash
# Generate the typescript-fetch SDK for openapi.yaml into generated-sdk/,
# with OpenAPI Generator 7.26.0 in Docker.
set -o errexit
set -o nounset

cd "$(dirname "$0")"
rm -rf generated-sdk/
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/local" \
  openapitools/openapi-generator-cli:v7.26.0 \
  generate \
  --input-spec /local/openapi.yaml \
  --generator-name typescript-fetch \
  --output /local/generated-sdk/
