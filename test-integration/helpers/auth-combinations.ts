"use strict";
/**
 * The source of `examples/auth-combinations/`: one folder for every
 * combination of MCP Auth and Upstream Auth, each with an OpenAPI document
 * using the upstream scheme, an OAG-MCP configuration, a script generating
 * the typescript-fetch SDK, a script starting OAG-MCP, and a README.
 *
 * Write the folders with:
 *   node_modules/.bin/tsx test-integration/helpers/auth-combinations.ts examples/auth-combinations
 *
 * test-integration/auth-combinations-examples.ts checks that the committed
 * folders match what this module renders, so edit here, not there.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The OpenAPI Generator version the SDK scripts use. */
export const OPENAPI_GENERATOR_VERSION = "7.26.0";

/** An MCP Auth mode. */
export interface McpAuth {
  /** Folder name part. */
  id: string;
  /** Heading name. */
  title: string;
  /** How the client connects, completing "An MCP client connects to OAG-MCP …". */
  phrase: string;
  transport: "stdio" | "streamable-http";
  /** The `mcpAuth` configuration, as YAML lines. */
  config: string[];
  /** Environment variables the mode needs, with a description each. */
  env: [string, string][];
  /** The principal the logs name. */
  principal: string;
  /** How the principal is established. */
  identity: string;
  /** Lines of the README's "Connect a client" section, given the secrets. */
  connect: (env: string[]) => string[];
}

/** An upstream security scheme. */
export interface UpstreamAuth {
  /** Folder name part. */
  id: string;
  /** Heading name. */
  title: string;
  /** What OAG-MCP calls with, completing "OAG-MCP calls the API with …". */
  phrase: string;
  /** The scheme name in the OpenAPI document; none for no security. */
  scheme?: string;
  /** The `securitySchemes` entry, as YAML lines. */
  definition: string[];
  /** Security requirement per operation, as YAML flow sequences. */
  security: { read: string; write: string };
  /** The `upstreamAuth.schemes` entry, as YAML lines. */
  config: string[];
  env: [string, string][];
  /** What the API receives. */
  receives: string;
}

export const MCP_AUTHS: McpAuth[] = [
  {
    id: "stdio",
    phrase: "over stdio, as a subprocess the client starts itself",
    title: "stdio",
    transport: "stdio",
    config: [
      "mcpAuth:",
      "  stdio:",
      "    principal: petstore-agent        # names the caller in the logs: local:petstore-agent",
    ],
    env: [],
    principal: "local:petstore-agent",
    identity:
      "The MCP client starts OAG-MCP as its own subprocess, so the operating system's process boundary is the access control and there is no token. Every call runs as the principal named in `mcpAuth.stdio.principal`.",
    connect: (env) => [
      "The MCP client starts `serve.sh` itself, passing it the secrets. With",
      "Claude Code, from this folder:",
      "",
      "```bash",
      env.length
        ? [
            "claude mcp add petstore \\",
            ...env.map((n) => `  --env ${n}="$${n}" \\`),
            '  -- "$PWD/serve.sh"',
          ].join("\n")
        : 'claude mcp add petstore -- "$PWD/serve.sh"',
      "```",
    ],
  },
  {
    id: "none",
    phrase: "over Streamable HTTP, without authentication",
    title: "none",
    transport: "streamable-http",
    config: [
      "mcpAuth:",
      "  mode: none                         # for local development; loopback addresses only",
    ],
    env: [],
    principal: "anonymous",
    identity:
      "Nobody is authenticated: every caller is `anonymous`, and only processes on this machine can connect, because OAG-MCP refuses to start with `none` on any other address.",
    connect: () => [
      "With Claude Code:",
      "",
      "```bash",
      "claude mcp add --transport http petstore http://127.0.0.1:3000/mcp",
      "```",
    ],
  },
  {
    id: "static-bearer",
    phrase: "over Streamable HTTP, with a pre-shared bearer token",
    title: "static bearer",
    transport: "streamable-http",
    config: [
      "mcpAuth:",
      "  mode: static-bearer",
      "  staticBearer:",
      "    tokens:",
      "      - principal: petstore-agent      # names the caller in the logs: static:petstore-agent",
      "        token: { env: OAG_MCP_TOKEN }  # at least 16 characters, e.g. openssl rand -hex 32",
    ],
    env: [
      [
        "OAG_MCP_TOKEN",
        "the bearer token MCP clients send, at least 16 characters",
      ],
    ],
    principal: "static:petstore-agent",
    identity:
      "The MCP client sends a pre-shared bearer token, and OAG-MCP maps it to the principal configured for it. Everyone holding the same token is the same principal.",
    connect: () => [
      "With Claude Code, sending the token:",
      "",
      "```bash",
      "claude mcp add --transport http petstore http://127.0.0.1:3000/mcp \\",
      '  --header "Authorization: Bearer $OAG_MCP_TOKEN"',
      "```",
    ],
  },
  {
    id: "oauth",
    phrase:
      "over Streamable HTTP, with an OAuth access token from your authorization server",
    title: "OAuth",
    transport: "streamable-http",
    config: [
      "mcpAuth:",
      "  mode: oauth",
      "  oauth:",
      "    issuer: https://auth.example.com/ # your authorization server",
      "    requiredScopes: [mcp:tools]",
      "    principalIdKey: { env: OAG_MCP_PRINCIPAL_ID_KEY }   # keeps principal ids stable across restarts",
      "    # Tokens are JWTs checked against the issuer's keys. For opaque tokens,",
      "    # use token introspection instead:",
      "    # introspection:",
      "    #   endpoint: https://auth.example.com/oauth/introspect",
      "    #   clientId: { env: OAG_MCP_INTROSPECTION_CLIENT_ID }",
      "    #   clientSecret: { env: OAG_MCP_INTROSPECTION_CLIENT_SECRET }",
    ],
    env: [
      [
        "OAG_MCP_PRINCIPAL_ID_KEY",
        "the secret key for principal ids, at least 32 characters, e.g. openssl rand -hex 32",
      ],
    ],
    principal: "oauth:<keyed hash of issuer and subject>",
    identity:
      "The MCP client sends an access token from your authorization server, which OAG-MCP validates on every request. The principal is a keyed hash of the token's issuer and subject, so the logs never show who the user is, and only the holder of `principalIdKey` can match an id to a user.",
    connect: () => [
      "Clients that support the MCP authorization flow read OAG-MCP's protected",
      "resource metadata, find your authorization server, and sign in there:",
      "",
      "```bash",
      "claude mcp add --transport http petstore http://127.0.0.1:3000/mcp",
      "```",
      "",
      "Or send a token you already have, with the `mcp:tools` scope and",
      "`http://127.0.0.1:3000/mcp` as its audience:",
      "",
      "```bash",
      "claude mcp add --transport http petstore http://127.0.0.1:3000/mcp \\",
      '  --header "Authorization: Bearer $ACCESS_TOKEN"',
      "```",
    ],
  },
];

export const UPSTREAM_AUTHS: UpstreamAuth[] = [
  {
    id: "none",
    phrase: "no credentials",
    title: "none",
    definition: [],
    security: { read: "[]", write: "[]" },
    config: [],
    env: [],
    receives: "No credentials.",
  },
  {
    id: "api-key-header",
    phrase: "an API key in the `X-Api-Key` header",
    title: "API key in a header",
    scheme: "apiKeyHeader",
    definition: [
      "    apiKeyHeader:",
      "      type: apiKey",
      "      in: header",
      "      name: X-Api-Key",
    ],
    security: { read: "[apiKeyHeader: []]", write: "[apiKeyHeader: []]" },
    config: ["    apiKeyHeader:", "      apiKey: { env: PETSTORE_API_KEY }"],
    env: [["PETSTORE_API_KEY", "the API key"]],
    receives: "OAG-MCP's API key, in the `X-Api-Key` header.",
  },
  {
    id: "api-key-query",
    phrase: "an API key in the `api_key` query parameter",
    title: "API key in the query",
    scheme: "apiKeyQuery",
    definition: [
      "    apiKeyQuery:",
      "      type: apiKey",
      "      in: query",
      "      name: api_key",
    ],
    security: { read: "[apiKeyQuery: []]", write: "[apiKeyQuery: []]" },
    config: ["    apiKeyQuery:", "      apiKey: { env: PETSTORE_API_KEY }"],
    env: [["PETSTORE_API_KEY", "the API key"]],
    receives: "OAG-MCP's API key, in the `api_key` query parameter.",
  },
  {
    id: "basic",
    phrase: "HTTP basic credentials",
    title: "HTTP basic",
    scheme: "basicAuth",
    definition: ["    basicAuth:", "      type: http", "      scheme: basic"],
    security: { read: "[basicAuth: []]", write: "[basicAuth: []]" },
    config: [
      "    basicAuth:",
      "      username: { env: PETSTORE_USERNAME }",
      "      password: { env: PETSTORE_PASSWORD }",
    ],
    env: [
      ["PETSTORE_USERNAME", "the API username"],
      ["PETSTORE_PASSWORD", "the API password"],
    ],
    receives: "OAG-MCP's username and password, as `Authorization: Basic …`.",
  },
  {
    id: "bearer",
    phrase: "an HTTP bearer token",
    title: "HTTP bearer",
    scheme: "bearerAuth",
    definition: ["    bearerAuth:", "      type: http", "      scheme: bearer"],
    security: { read: "[bearerAuth: []]", write: "[bearerAuth: []]" },
    config: ["    bearerAuth:", "      token: { env: PETSTORE_TOKEN }"],
    env: [["PETSTORE_TOKEN", "the API token"]],
    receives: "OAG-MCP's token, as `Authorization: Bearer …`.",
  },
  {
    id: "oauth2-client-credentials",
    phrase: "an OAuth2 token it obtains with the client credentials flow",
    title: "OAuth2 client credentials",
    scheme: "petstoreOAuth",
    definition: [
      "    petstoreOAuth:",
      "      type: oauth2",
      "      flows:",
      "        clientCredentials:",
      "          tokenUrl: https://auth.example.com/oauth/token",
      "          scopes:",
      "            pets:read: Read pets",
      "            pets:write: Register pets",
    ],
    security: {
      read: "[petstoreOAuth: [pets:read]]",
      write: "[petstoreOAuth: [pets:write]]",
    },
    config: [
      "    petstoreOAuth:",
      "      clientId: { env: PETSTORE_CLIENT_ID }",
      "      clientSecret: { env: PETSTORE_CLIENT_SECRET }",
    ],
    env: [
      ["PETSTORE_CLIENT_ID", "OAG-MCP's OAuth2 client id"],
      ["PETSTORE_CLIENT_SECRET", "OAG-MCP's OAuth2 client secret"],
    ],
    receives:
      "A token issued to OAG-MCP's client id, which OAG-MCP obtains, caches and renews itself, as `Authorization: Bearer …`.",
  },
];

/** The folder name of a combination. */
export function folderName(mcp: McpAuth, upstream: UpstreamAuth): string {
  return `mcp-${mcp.id}-upstream-${upstream.id}`;
}

/** The OpenAPI document for an upstream scheme. */
export function renderSpec(upstream: UpstreamAuth): string {
  const schemes = upstream.definition.length
    ? ["  securitySchemes:", ...upstream.definition]
    : [];
  return [
    "openapi: 3.0.3",
    "info:",
    "  title: Pet Store",
    "  version: 1.0.0",
    `  description: A small pet store API, secured with ${upstream.title === "none" ? "no authentication" : upstream.title}.`,
    "servers:",
    "  - url: https://petstore.example.com/v1",
    "tags:",
    "  - name: pets",
    "    description: Pets in the store",
    "paths:",
    "  /pets:",
    "    get:",
    "      operationId: listPets",
    "      summary: List pets",
    "      tags: [pets]",
    `      security: ${upstream.security.read}`,
    "      parameters:",
    "        - name: limit",
    "          in: query",
    "          description: Maximum number of pets to return",
    "          schema: { type: integer, minimum: 1, maximum: 100 }",
    "      responses:",
    "        '200':",
    "          description: The pets",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: array",
    "                items: { $ref: '#/components/schemas/Pet' }",
    "    post:",
    "      operationId: createPet",
    "      summary: Register a pet",
    "      tags: [pets]",
    `      security: ${upstream.security.write}`,
    "      requestBody:",
    "        required: true",
    "        content:",
    "          application/json:",
    "            schema: { $ref: '#/components/schemas/NewPet' }",
    "      responses:",
    "        '201':",
    "          description: The registered pet",
    "          content:",
    "            application/json:",
    "              schema: { $ref: '#/components/schemas/Pet' }",
    "  /pets/{petId}:",
    "    get:",
    "      operationId: getPetById",
    "      summary: Get a pet",
    "      tags: [pets]",
    `      security: ${upstream.security.read}`,
    "      parameters:",
    "        - name: petId",
    "          in: path",
    "          required: true",
    "          schema: { type: integer }",
    "      responses:",
    "        '200':",
    "          description: The pet",
    "          content:",
    "            application/json:",
    "              schema: { $ref: '#/components/schemas/Pet' }",
    "        '404':",
    "          description: No such pet",
    "components:",
    ...schemes,
    "  schemas:",
    "    NewPet:",
    "      type: object",
    "      required: [name, species]",
    "      properties:",
    "        name: { type: string }",
    "        species: { type: string, enum: [cat, dog, bird] }",
    "    Pet:",
    "      allOf:",
    "        - $ref: '#/components/schemas/NewPet'",
    "        - type: object",
    "          required: [id]",
    "          properties:",
    "            id: { type: integer }",
    "",
  ].join("\n");
}

/** All environment variables a combination needs. */
function _env(mcp: McpAuth, upstream: UpstreamAuth): [string, string][] {
  return [...mcp.env, ...upstream.env];
}

/** The OAG-MCP configuration of a combination. */
export function renderConfig(mcp: McpAuth, upstream: UpstreamAuth): string {
  const env = _env(mcp, upstream);
  const lines = [
    `# OAG-MCP configuration: MCP Auth ${mcp.title}, Upstream Auth ${upstream.title}.`,
    "# See README.md in this folder, and docs/recipes/auth-combinations.md.",
  ];
  if (env.length) {
    lines.push(
      "# Secrets are referenced by environment variable, never written here:",
      ...env.map(([name, about]) => `#   ${name}: ${about}`),
    );
  }
  lines.push(
    "",
    "upstream:",
    "  baseUrl: https://petstore.example.com/v1   # your API; defaults to the document's server URL",
  );
  if (upstream.config.length) {
    lines.push("", "upstreamAuth:", "  schemes:", ...upstream.config);
  }
  lines.push("", ...mcp.config, "");
  return lines.join("\n");
}

/** The script generating the typescript-fetch SDK. */
export function renderGenerateSdk(): string {
  return [
    "#!/usr/bin/env bash",
    "# Generate the typescript-fetch SDK for openapi.yaml into generated-sdk/,",
    `# with OpenAPI Generator ${OPENAPI_GENERATOR_VERSION} in Docker.`,
    "set -o errexit",
    "set -o nounset",
    "",
    'cd "$(dirname "$0")"',
    "rm -rf generated-sdk/",
    "docker run --rm \\",
    '  --user "$(id -u):$(id -g)" \\',
    '  -v "$PWD:/local" \\',
    `  openapitools/openapi-generator-cli:v${OPENAPI_GENERATOR_VERSION} \\`,
    "  generate \\",
    "  --input-spec /local/openapi.yaml \\",
    "  --generator-name typescript-fetch \\",
    "  --output /local/generated-sdk/",
    "",
  ].join("\n");
}

/** The script starting OAG-MCP. */
export function renderServe(mcp: McpAuth, upstream: UpstreamAuth): string {
  const env = _env(mcp, upstream);
  const transport =
    mcp.transport === "stdio"
      ? ["  --transport stdio \\"]
      : ["  --transport streamable-http --port 3000 \\"];
  return [
    "#!/usr/bin/env bash",
    `# Start OAG-MCP with MCP Auth ${mcp.title} and Upstream Auth ${upstream.title},`,
    "# serving openapi.yaml and the SDK that generate-sdk.sh generated.",
    "# Logs and security audit records go to oag-mcp.log in this folder.",
    "set -o errexit",
    "set -o nounset",
    "",
    'cd "$(dirname "$0")"',
    ...env.map(([name, about]) => `: "\${${name}:?Set ${name} to ${about}}"`),
    "exec oag-mcp serve \\",
    "  --spec openapi.yaml \\",
    "  --sdk generated-sdk/ \\",
    "  --config oag-mcp.config.yaml \\",
    ...transport,
    "  --log-file oag-mcp.log --audit-log-file oag-mcp.log",
    "",
  ].join("\n");
}

/** The README of a combination. */
export function renderReadme(mcp: McpAuth, upstream: UpstreamAuth): string {
  const env = _env(mcp, upstream);
  const schemes = upstream.scheme ? `["${upstream.scheme}"]` : "[]";
  const connect = mcp.connect(env.map(([name]) => name));
  return [
    `# MCP Auth ${mcp.title}, Upstream Auth ${upstream.title}`,
    "",
    `An MCP client connects to OAG-MCP ${mcp.phrase}, and OAG-MCP calls the`,
    `Pet Store API with ${upstream.phrase}. This is one of the`,
    "[MCP Auth and Upstream Auth combinations](../../../docs/recipes/auth-combinations.md).",
    "",
    "| File | What it is |",
    "| --- | --- |",
    `| \`openapi.yaml\` | The Pet Store API, ${upstream.scheme ? `with the \`${upstream.scheme}\` security scheme` : "without security"} |`,
    "| `oag-mcp.config.yaml` | The OAG-MCP configuration |",
    "| `generate-sdk.sh` | Generates the typescript-fetch SDK into `generated-sdk/` |",
    "| `serve.sh` | Starts OAG-MCP with the document, the SDK and the configuration |",
    "",
    "## Run it",
    "",
    `1. Point \`upstream.baseUrl\` in \`oag-mcp.config.yaml\` at your API${upstream.scheme ? `, and\n   make sure the API uses the \`${upstream.scheme}\` scheme as \`openapi.yaml\` describes it` : ""}.`,
    "2. Generate the SDK, which needs Docker:",
    "",
    "   ```bash",
    "   ./generate-sdk.sh",
    "   ```",
    "",
    ...(env.length
      ? [
          "3. Set the secrets:",
          "",
          "   ```bash",
          ...env.map(([name]) => `   export ${name}=…`),
          "   ```",
          "",
        ]
      : ["3. No secrets are needed.", ""]),
    `4. ${mcp.transport === "stdio" ? "Connect a client, which starts OAG-MCP itself (see below)." : "Start OAG-MCP, which listens on `http://127.0.0.1:3000/mcp`:"}`,
    ...(mcp.transport === "stdio"
      ? []
      : ["", "   ```bash", "   ./serve.sh", "   ```"]),
    "",
    "## Connect a client",
    "",
    ...connect,
    "",
    "## Check the identity",
    "",
    "| Actor | Identified as | Where to look |",
    "| --- | --- | --- |",
    `| The agent | \`${mcp.principal}\` | \`actor.user.uid\` in audit records |`,
    "| OAG-MCP | Its instance id, new for every process | `metadata.reporter.uid` in audit records |",
    `| What the API sees | ${upstream.receives} | \`unmapped.schemes\` in \`authorization.allowed\`: \`${schemes}\` |`,
    "",
    mcp.identity,
    "",
    "Each API call is recorded in `oag-mcp.log`. To list who made each call,",
    "and with which credentials:",
    "",
    "```bash",
    'jq -r \'select(.metadata.event_code == "authorization.allowed")',
    '  | "\\(.time_dt) \\(.actor.user.uid) \\(.api.operation) \\(.unmapped.schemes | join(","))"\' oag-mcp.log',
    "```",
    "",
    "[Identity](../../../docs/identity.md) explains these records in full.",
    "",
  ].join("\n");
}

/** Every file of every combination, by path relative to the examples folder. */
export function renderAll(): Map<string, string> {
  const files = new Map<string, string>();
  for (const mcp of MCP_AUTHS) {
    for (const upstream of UPSTREAM_AUTHS) {
      const dir = folderName(mcp, upstream);
      files.set(`${dir}/openapi.yaml`, renderSpec(upstream));
      files.set(`${dir}/oag-mcp.config.yaml`, renderConfig(mcp, upstream));
      files.set(`${dir}/generate-sdk.sh`, renderGenerateSdk());
      files.set(`${dir}/serve.sh`, renderServe(mcp, upstream));
      files.set(`${dir}/README.md`, renderReadme(mcp, upstream));
    }
  }
  files.set(
    ".gitignore",
    "# Generated by each folder's generate-sdk.sh, and written by serve.sh.\n*/generated-sdk/\n*/oag-mcp.log\n",
  );
  return files;
}

/** Write every combination into `root`. */
export function writeAll(root: string): void {
  for (const [file, content] of renderAll()) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (file.endsWith(".sh")) {
      fs.chmodSync(target, 0o755);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeAll(process.argv[2] ?? "examples/auth-combinations");
}
