"use strict";
/**
 * MCP server definition: exactly two tools, `search` and `execute`, with the
 * same behaviour on every transport.
 *
 * @module runtime/mcp-server
 */
import crypto from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import type { Principal } from "../types.js";
import { oagMcpVersion } from "../util/version.js";
import type { OagMcpService } from "./service.js";

/** The only tools oag-mcp exposes. */
export const TOOL_NAMES = ["search", "execute"] as const;

/** Tool descriptions computed once per service (process). */
const DESCRIPTIONS = new WeakMap<
  OagMcpService,
  { search: string; execute: string }
>();

/**
 * Tool descriptions for a service, computed once.
 *
 * @private
 */
function _descriptions(service: OagMcpService): {
  search: string;
  execute: string;
} {
  let d = DESCRIPTIONS.get(service);
  if (!d) {
    d = {
      search: searchDescription(service),
      execute: executeDescription(service),
    };
    DESCRIPTIONS.set(service, d);
  }
  return d;
}

/**
 * Build the description of the execute tool.
 *
 * @param {Object} service - service
 * @return {String} description
 */
export function executeDescription(service: OagMcpService): string {
  const apis = service.apiClasses().join(", ");
  return [
    `Run JavaScript or TypeScript that calls the ${service.info.api.title} API through its generated SDK.`,
    "Write the BODY of an async function: use `await`, combine several calls, loop, filter and aggregate, then `return` a JSON-serialisable result (keep it small).",
    `A global \`sdk\` binding exposes the SDK API classes: ${apis}. Call methods as \`sdk.<ApiClass>.<method>(...)\` exactly as shown by the search tool; the base URL and credentials are configured by the server.`,
    "No imports, network, filesystem, environment or subprocess access. `console.log` output is captured (bounded). TypeScript is type-checked against the SDK before running.",
    "Example:\n```ts\nconst items = await sdk.PetsApi.listPets({ limit: 50 });\nreturn items.filter((p) => p.vaccinated).map((p) => p.name);\n```",
    "Errors are structured: syntax_error, type_error (with diagnostics), api_error (HTTP status and body), permission_denied, timeout, output_limit, resource_limit.",
  ].join("\n\n");
}

/**
 * Build the description of the search tool.
 *
 * @param {Object} service - service
 * @return {String} description
 */
export function searchDescription(service: OagMcpService): string {
  return [
    `Discover methods of the ${service.info.api.title} SDK available to the execute tool.`,
    '- `{ query }`: ranked full-text search (e.g. "list pets by species"); returns ids, signatures and summaries.',
    "- `{ id }`: full details for one method: signature, input/return types, referenced type declarations, auth and an example.",
    "- `{}` or `{ tag }`: browse API classes and their methods when you do not know the vocabulary yet.",
  ].join("\n");
}

/**
 * Format a tool result with text and structured content.
 *
 * @private
 */
function _result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
    isError,
  };
}

/**
 * Create an MCP server instance bound to one principal.
 *
 * @param {Object} service - service
 * @param {Object} principal - authenticated principal
 * @param {String} transport - transport name
 * @param {String} [httpRequestId] - correlation id of the HTTP request
 * @return {McpServer} server
 */
export function createMcpServer(
  service: OagMcpService,
  principal: Principal,
  transport: "stdio" | "streamable-http",
  httpRequestId?: string,
): McpServer {
  const server = new McpServer(
    {
      name: "oag-mcp",
      version: oagMcpVersion(),
      title: `${service.info.api.title} (oag-mcp)`,
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Use `search` to find SDK methods (start with no arguments to browse), then `execute` TypeScript that calls them via the `sdk` binding. Return only the data you need.",
    },
  );
  const requestId = () => httpRequestId ?? `req_${crypto.randomUUID()}`;
  server.registerTool(
    "search",
    {
      title: "Search SDK methods",
      description: _descriptions(service).search,
      inputSchema: z.object({
        query: z
          .string()
          .max(500)
          .optional()
          .describe("Keywords describing what you want to do"),
        id: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Exact method id from a previous result, e.g. 'PetsApi.listPets'",
          ),
        tag: z
          .string()
          .max(200)
          .optional()
          .describe("Restrict to an API class or OpenAPI tag"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum results (default 5)"),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const out = service.search(args, {
        principal,
        requestId: requestId(),
        transport,
      });
      return _result(out, Boolean(out.error));
    },
  );
  server.registerTool(
    "execute",
    {
      title: "Execute SDK code",
      description: _descriptions(service).execute,
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .max(200000)
          .describe("Body of an async function using the `sdk` binding"),
        language: z
          .enum(["typescript", "javascript"])
          .optional()
          .describe("Default: typescript (type-checked)"),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(600000)
          .optional()
          .describe("Wall-clock limit for this execution"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await service.execute(args, {
        principal,
        requestId: requestId(),
        transport,
      });
      return _result(out as unknown as Record<string, unknown>, !out.ok);
    },
  );
  return server;
}
