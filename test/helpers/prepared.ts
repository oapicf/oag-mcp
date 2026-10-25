"use strict";
/**
 * A prepared SDK and an executor that need neither a workspace nor Deno.
 */
import os from "node:os";
import path from "node:path";

import sinon from "sinon";

import type {
  ExecutionOutcome,
  ExecutionRequest,
  Executor,
} from "../../lib/executor/types.js";
import type { PreparedSdk } from "../../lib/prepare/prepare.js";
import { MethodSearchIndex } from "../../lib/search/search-index.js";
import type {
  MethodRecord,
  OperationBinding,
  PreparedSdkInfo,
} from "../../lib/types.js";
import { SCHEMES } from "./fakes.js";

export const BASE = "https://api.example.test/v1";

export const BINDINGS: OperationBinding[] = [
  {
    id: "PetsApi.listPets",
    className: "PetsApi",
    methodName: "listPets",
    httpMethod: "GET",
    path: "/pets",
    tags: ["pets"],
    security: [],
  },
  {
    id: "AdminApi.deletePet",
    className: "AdminApi",
    methodName: "deletePet",
    httpMethod: "DELETE",
    path: "/pets/{petId}",
    tags: ["admin"],
    security: [],
  },
];

/**
 * A method record; `overrides` replace any field.
 */
export function record(
  binding: OperationBinding,
  overrides: Partial<MethodRecord> = {},
): MethodRecord {
  return {
    id: binding.id,
    className: binding.className,
    methodName: binding.methodName,
    sdkPath: `sdk.${binding.id}`,
    operationId: binding.methodName,
    httpMethod: binding.httpMethod,
    path: binding.path,
    tags: binding.tags,
    summary: `Summary of ${binding.methodName}`,
    description: `Description of ${binding.methodName}`,
    deprecated: false,
    signature: `${binding.methodName}(): Promise<void>`,
    parameters: [],
    returnType: "Promise<void>",
    referencedTypes: [],
    requiredArguments: [],
    apiParameters: [
      {
        name: "limit",
        in: "query",
        required: false,
        description: "How many",
        schemaType: "integer",
      },
    ],
    responses: { "200": "ok" },
    auth: { alternatives: [], optional: true, unsupportedSchemes: [] },
    security: [],
    example: `return await ${`sdk.${binding.id}`}();`,
    ...overrides,
  };
}

/**
 * A prepared SDK without a workspace: the records are indexed in memory.
 */
export function prepared(
  opts: { records?: MethodRecord[]; servers?: string[] } = {},
): PreparedSdk {
  const records = opts.records ?? BINDINGS.map((b) => record(b));
  const info = {
    prepareId: "prep_1",
    api: {
      title: "Pet Clinic",
      version: "1.0.0",
      servers: opts.servers ?? [BASE],
      tags: [],
    },
    securitySchemes: { apiKeyHeader: SCHEMES.apiKeyHeader },
    operations: BINDINGS,
    unmappedOperations: [],
  } as unknown as PreparedSdkInfo;
  return {
    info,
    workspaceDir: path.join(os.tmpdir(), "oag-mcp-unit-workspace"),
    records,
    bindings: BINDINGS,
    index: new MethodSearchIndex(records),
    warnings: [],
    cleanup: () => true,
  };
}

/**
 * An executor whose outcome is scripted per test.
 */
export function executor(
  run: (
    req: ExecutionRequest,
  ) => Promise<Partial<ExecutionOutcome>> = async () => ({
    ok: true,
    result: 1,
  }),
): Executor & { execute: sinon.SinonSpy } {
  return {
    name: "fake",
    verify: async () => {},
    execute: sinon.spy(async (req: ExecutionRequest) => ({
      ok: false,
      logs: [],
      logsTruncated: false,
      stats: { durationMs: 1, sdkCalls: 0, terminated: false },
      ...(await run(req)),
    })),
  };
}
