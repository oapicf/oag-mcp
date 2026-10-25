"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import referee from "@sinonjs/referee";
import sinon from "sinon";

import { type Config, parseConfig } from "../../lib/config.js";
import { OagMcpError } from "../../lib/errors.js";
import { DenoExecutor } from "../../lib/executor/deno-executor.js";
import { AgentTypeChecker } from "../../lib/executor/typecheck.js";
import type {
  ExecutionOutcome,
  ExecutionRequest,
  Executor,
} from "../../lib/executor/types.js";
import { Logs } from "../../lib/logger.js";
import type { PreparedSdk } from "../../lib/prepare/prepare.js";
import { MethodSearchIndex } from "../../lib/search/search-index.js";
import { type CallContext, OagMcpService } from "../../lib/server/service.js";
import type {
  MethodRecord,
  OperationBinding,
  PreparedSdkInfo,
} from "../../lib/types.js";
import { secrets } from "../../lib/util/redact.js";
import { SCHEMES, fakeFetch, quietLogs } from "../helpers/fakes.js";
import { readLogRecords } from "../helpers/log-records.js";

const { assert, refute, match } = referee;

const BASE = "https://api.example.test/v1";

const BINDINGS: OperationBinding[] = [
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
function record(
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
function prepared(
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
 * Configuration with defaults; type checking off unless asked for.
 */
function config(raw: Record<string, unknown> = {}): Config {
  const execution = (raw.execution ?? {}) as Record<string, unknown>;
  return parseConfig({
    ...raw,
    execution: { typecheck: false, ...execution },
  });
}

/**
 * An executor whose outcome is scripted per test.
 */
function executor(
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

const CTX: CallContext = {
  principal: { id: "local:test", kind: "local", name: "test", scopes: [] },
  requestId: "req_1",
  transport: "stdio",
};

/**
 * A service over the fake SDK.
 */
async function service(
  opts: {
    config?: Config;
    executor?: Executor;
    records?: MethodRecord[];
    servers?: string[];
    logs?: Logs;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{
  svc: OagMcpService;
  records: ReturnType<typeof quietLogs>["records"];
}> {
  const q = quietLogs();
  const svc = await OagMcpService.create({
    prepared: prepared({ records: opts.records, servers: opts.servers }),
    config: opts.config ?? config(),
    configBaseDir: process.cwd(),
    logs: opts.logs ?? q.logs,
    executor: opts.executor ?? executor(),
    fetchImpl: opts.fetchImpl,
  });
  return { svc, records: q.records };
}

describe("service - create", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("should use the configured base URL, or the spec's first server", async function () {
    const fromSpec = await service();
    assert.equals(fromSpec.svc.broker.sdkBasePath, BASE);
    const configured = await service({
      config: config({ upstream: { baseUrl: "http://127.0.0.1:4010/api" } }),
    });
    assert.equals(
      configured.svc.broker.sdkBasePath,
      "http://127.0.0.1:4010/api",
    );
  });

  it("should require an absolute http(s) upstream base URL", async function () {
    await assert.rejects(
      service({ servers: [] }),
      match({ code: "CONFIG_BASE_URL_REQUIRED", message: match(/none/) }),
    );
    const err = await service({ servers: ["ftp://files.example.test"] }).catch(
      (e: unknown) => e,
    );
    assert(err instanceof OagMcpError);
    assert.match((err as OagMcpError).message, /ftp:\/\/files/);
    assert.match((err as OagMcpError).hint!, /upstream\.baseUrl/);
  });

  it("should audit the authorization and execution policies", async function () {
    const implicit = await service();
    const policy = implicit
      .records()
      .find((r) => r.event === "authorization.policy_loaded")!;
    assert.equals(policy.get("policyMode"), "implicit-allow-all");
    assert.equals(policy.get("default"), "allow");
    assert.equals(policy.get("rules"), 0);
    const applied = implicit
      .records()
      .find((r) => r.event === "execution.policy.applied")!;
    assert.equals(applied.get("upstreamOrigin"), "https://api.example.test");

    const configured = await service({
      config: config({
        authorization: {
          default: "deny",
          rules: [{ id: "read", allow: ["method:GET"], deny: [] }],
        },
      }),
    });
    const loaded = configured
      .records()
      .find((r) => r.event === "authorization.policy_loaded")!;
    assert.equals(loaded.get("policyMode"), "configured");
    assert.equals(loaded.get("rules"), 1);
    assert.equals(loaded.get("default"), "deny");
  });

  it("should resolve Deno and verify the bundle when no executor is given", async function () {
    const verify = sinon.stub(DenoExecutor.prototype, "verify").resolves();
    const q = quietLogs();
    const svc = await OagMcpService.create({
      prepared: prepared(),
      config: config(),
      configBaseDir: process.cwd(),
      logs: q.logs,
    });
    assert(svc.executor instanceof DenoExecutor);
    assert.equals(verify.callCount, 1);
    assert.equals(verify.firstCall.args, [BINDINGS, BASE]);
    const events = q.records().map((r) => r.event);
    assert.contains(events, "executor.runtime.resolved");
    assert.contains(events, "executor.verified");
  });

  it("should create a type checker only when type checking is enabled", async function () {
    const check = sinon.stub(AgentTypeChecker.prototype, "check").returns([]);
    const off = await service();
    await off.svc.execute({ code: "return 1;" }, CTX);
    assert.equals(check.callCount, 0);
    const on = await service({
      config: config({ execution: { typecheck: true } }),
    });
    await on.svc.execute({ code: "return 1;" }, CTX);
    assert.equals(check.callCount, 1);
  });
});

describe("service - warmUp", function () {
  afterEach(function () {
    sinon.restore();
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("should warm the type checker in the background", async function () {
    const warm = sinon.stub(AgentTypeChecker.prototype, "warmUp");
    const q = quietLogs();
    const { svc } = await service({
      config: config({ execution: { typecheck: true } }),
      logs: q.logs,
    });
    svc.warmUp();
    assert.equals(warm.callCount, 0, "not synchronously");
    await settle();
    assert.equals(warm.callCount, 1);
    assert.contains(
      q.records().map((r) => r.event),
      "typecheck.warmed",
    );
  });

  it("should report a failed warm-up without throwing", async function () {
    sinon
      .stub(AgentTypeChecker.prototype, "warmUp")
      .throws(new RangeError("boom"));
    const q = quietLogs();
    const { svc } = await service({
      config: config({ execution: { typecheck: true } }),
      logs: q.logs,
    });
    svc.warmUp();
    await settle();
    const failed = q
      .records()
      .find((r) => r.event === "typecheck.warm_failed")!;
    assert.equals(failed.get("error"), "RangeError");
  });
});

describe("service - apiClasses", function () {
  it("should list the API classes once each, sorted", async function () {
    const { svc } = await service();
    assert.equals(svc.apiClasses(), ["AdminApi", "PetsApi"]);
  });
});

describe("service - search", function () {
  const reader = {
    ...CTX,
    principal: {
      ...CTX.principal,
      id: "static:reader",
      kind: "static" as const,
    },
  };
  const readOnly = () =>
    config({
      authorization: {
        default: "deny",
        rules: [{ id: "read", allow: ["method:GET"], deny: [] }],
      },
    });

  it("should browse the visible APIs without a query", async function () {
    const { svc, records } = await service({ config: readOnly() });
    const out = svc.search({}, reader);
    assert.equals(out.api, { title: "Pet Clinic", version: "1.0.0" });
    assert.match(JSON.stringify(out.apis), /listPets/);
    refute.match(JSON.stringify(out.apis), /deletePet/);
    const done = records().find((r) => r.event === "search.completed")!;
    assert.equals(done.get("mode"), "browse");
    assert.isUndefined(done.get("results"));
  });

  it("should return visible matches for a query, with a hint for none", async function () {
    const { svc, records } = await service({ config: readOnly() });
    const found = svc.search({ query: "list pets", limit: 50 }, reader);
    assert.equals(
      (found.results as Array<{ id: string }>).map((r) => r.id),
      ["PetsApi.listPets"],
    );
    assert.match(String(found.hint), /search with \{ id \}/);
    assert.equals(
      records()
        .find((r) => r.event === "search.completed")!
        .get("results"),
      1,
    );
    const forbidden = svc.search({ query: "delete pet" }, reader);
    refute.match(JSON.stringify(forbidden.results), /deletePet/);
    const none = svc.search({ query: "zzqqxx" }, reader);
    assert.equals(none.results, []);
    assert.match(String(none.hint), /No matches/);
    const blank = svc.search({ query: "   " }, reader);
    assert.isArray(blank.apis, "a blank query browses");
  });

  it("should describe one visible method by id", async function () {
    const { svc } = await service();
    const out = svc.search({ id: "PetsApi.listPets" }, CTX);
    const m = out.method as Record<string, unknown>;
    assert.equals(m.id, "PetsApi.listPets");
    assert.equals(m.sdkPath, "sdk.PetsApi.listPets");
    assert.isUndefined(m.deprecated);
    assert.isUndefined(m.requestBody);
    assert.isUndefined(m.inputType);
    assert.equals(m.apiParameters, [
      {
        name: "limit",
        in: "query",
        required: false,
        type: "integer",
        description: "How many",
      },
    ]);
    assert.match(String(m.example), /sdk\.PetsApi\.listPets/);
  });

  it("should include the request body, input type and deprecation, and clip long text", async function () {
    const [list, del] = BINDINGS;
    const { svc } = await service({
      records: [
        record(list, {
          deprecated: true,
          description: "d".repeat(2000),
          inputType: { name: "ListPetsRequest", declaration: "interface X {}" },
          requestBody: {
            required: true,
            contentTypes: ["application/json"],
            schemaType: "object",
            description: "ignored",
          },
          apiParameters: [
            {
              name: "q",
              in: "query",
              required: false,
              description: "p".repeat(400),
              schemaType: "string",
            },
          ],
        }),
        record(del, { description: undefined }),
      ],
    });
    const m = svc.search({ id: "PetsApi.listPets" }, CTX).method as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output
      any
    >;
    assert.isTrue(m.deprecated);
    assert.equals(m.inputType, "interface X {}");
    assert.equals(m.requestBody, {
      required: true,
      contentTypes: ["application/json"],
      type: "object",
    });
    assert.equals(m.description.length, 1501);
    assert.match(m.description, /…$/);
    assert.equals(m.apiParameters[0].description.length, 301);
    const plain = svc.search({ id: "AdminApi.deletePet" }, CTX)
      .method as Record<string, unknown>;
    assert.isUndefined(plain.description);
  });

  it("should not reveal unknown or forbidden methods by id", async function () {
    const { svc } = await service({ config: readOnly() });
    for (const id of ["Nope.nope", "AdminApi.deletePet"]) {
      const out = svc.search({ id }, reader);
      assert.isUndefined(out.method);
      assert.match(String(out.error), new RegExp(`"${id}"`));
    }
  });

  it("should not reveal records without a binding", async function () {
    const orphan = record({
      ...BINDINGS[0],
      id: "GhostApi.haunt",
      className: "GhostApi",
      methodName: "haunt",
    });
    const { svc } = await service({
      records: [...BINDINGS.map((b) => record(b)), orphan],
    });
    assert.isString(svc.search({ id: "GhostApi.haunt" }, CTX).error);
  });

  it("should drop detail from a large method description, then truncate", async function () {
    const types = (n: number, size: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `T${i}`,
        declaration: `interface T${i} { ${"x".repeat(size)} }`,
      }));
    const [list, del] = BINDINGS;
    const { svc } = await service({
      records: [
        record(list, { referencedTypes: types(5, 6000) }),
        record(del, { referencedTypes: types(3, 10000) }),
      ],
    });
    const trimmed = svc.search({ id: "PetsApi.listPets" }, CTX)
      .method as Record<string, unknown>;
    assert.equals((trimmed.referencedTypes as string[]).length, 3);
    assert.isUndefined(trimmed.apiParameters);
    const truncated = svc.search({ id: "AdminApi.deletePet" }, CTX);
    assert.isTrue(truncated.truncated);
    assert.match(String(truncated.note), /narrow the query/);
    assert.isString(truncated.preview);
  });
});

describe("service - execute", function () {
  afterEach(function () {
    sinon.restore();
  });

  const audits = (records: ReturnType<typeof quietLogs>["records"]) =>
    records()
      .filter((r) => r.category === "security_audit")
      .map((r) => r.event);

  it("should run the code and return its result, logs and stats", async function () {
    const exec = executor(async () => ({
      ok: true,
      result: { pets: 2 },
      logs: [{ level: "log", message: "hello" }],
      stats: { durationMs: 3, sdkCalls: 2, terminated: false },
    }));
    const { svc, records } = await service({ executor: exec });
    const out = await svc.execute(
      { code: "return 1;", language: "javascript" },
      CTX,
    );
    assert.isTrue(out.ok);
    assert.equals(out.result, { pets: 2 });
    assert.equals(out.logs, [{ level: "log", message: "hello" }]);
    assert.equals(out.stats.sdkCalls, 2);
    assert.isUndefined(out.hint);
    assert.match(out.executionId, /^exec_/);
    const req = exec.execute.firstCall.args[0] as ExecutionRequest;
    assert.equals(req.executionId, out.executionId);
    assert.equals(req.basePath, BASE);
    assert.equals(req.bindings, BINDINGS);
    assert.isString(req.moduleBase64);
    assert.contains(audits(records), "execution.requested");
    const events = records().map((r) => r.event);
    assert.contains(events, "execution.started");
    assert.contains(events, "execution.completed");
  });

  it("should clamp the requested timeout between 100 ms and the configured maximum", async function () {
    const exec = executor();
    const { svc } = await service({
      executor: exec,
      config: config({ execution: { timeoutMs: 2000, maxTimeoutMs: 5000 } }),
    });
    const limit = async (timeoutMs?: number) => {
      await svc.execute({ code: "return 1;", timeoutMs }, CTX);
      return (exec.execute.lastCall.args[0] as ExecutionRequest).limits
        .timeoutMs;
    };
    assert.equals(await limit(), 2000);
    assert.equals(await limit(1), 100);
    assert.equals(await limit(60000), 5000);
    assert.equals(await limit(3000), 3000);
  });

  it("should hint when the code returns no value", async function () {
    const { svc } = await service({
      executor: executor(async () => ({
        ok: true,
        result: null,
        resultUndefined: true,
      })),
    });
    const out = await svc.execute({ code: "1;" }, CTX);
    assert.isTrue(out.ok);
    assert.match(out.hint!, /use `return`/);
  });

  it("should scrub registered secrets from results, logs and errors", async function () {
    secrets.add("service-test-secret-123");
    const { svc } = await service({
      executor: executor(async () => ({
        ok: true,
        result: { echoed: "token service-test-secret-123" },
        logs: [{ level: "log", message: "saw service-test-secret-123" }],
      })),
    });
    const out = await svc.execute({ code: "return 1;" }, CTX);
    refute.contains(JSON.stringify(out), "service-test-secret-123");
    const failing = await service({
      executor: executor(async () => ({
        error: {
          type: "runtime_error",
          message: "failed with service-test-secret-123",
        },
      })),
    });
    const err = await failing.svc.execute({ code: "return 1;" }, CTX);
    assert.isFalse(err.ok);
    refute.contains(JSON.stringify(err), "service-test-secret-123");
    assert.isUndefined(err.result);
  });

  it("should give the sandbox a bridge to the request broker for the caller", async function () {
    const f = fakeFetch(() => new Response("[]"));
    const exec = executor(async (req) => {
      const res = await req.bridge(
        {
          rid: 1,
          binding: "PetsApi.listPets",
          url: `${BASE}/pets`,
          method: "GET",
          headers: {},
          body: null,
        },
        new AbortController().signal,
      );
      return { ok: res.ok, result: res.ok ? res.status : undefined };
    });
    const { svc, records } = await service({ executor: exec, fetchImpl: f });
    const out = await svc.execute({ code: "return 1;" }, CTX);
    assert.equals(out.result, 200);
    assert.equals(f.calls.length, 1);
    const allowed = records().find((r) => r.event === "authorization.allowed")!;
    assert.equals(allowed.principalId, "local:test");
    assert.equals(allowed.requestId, "req_1");
    assert.equals(allowed.executionId, out.executionId);
  });

  it("should refuse code that imports modules, and audit it", async function () {
    const exec = executor();
    const { svc, records } = await service({ executor: exec });
    const out = await svc.execute(
      { code: 'import fs from "node:fs"; return 1;', language: "javascript" },
      CTX,
    );
    assert.isFalse(out.ok);
    assert.equals(out.error!.reason, "import_not_allowed");
    assert.equals(exec.execute.callCount, 0);
    assert.contains(audits(records), "execution.import_denied");
  });

  it("should refuse code over the size limit, and audit it", async function () {
    const { svc, records } = await service({
      config: config({ execution: { maxCodeBytes: 256 } }),
    });
    const out = await svc.execute(
      { code: `return "${"x".repeat(300)}";` },
      CTX,
    );
    assert.equals(out.error!.type, "resource_limit");
    const limit = records().find(
      (r) => r.event === "execution.resource_limit",
    )!;
    assert.equals(limit.get("limit"), "maxCodeBytes");
    assert.equals(limit.get("value"), 256);
  });

  it("should refuse code that does not parse, without an import or size audit", async function () {
    const { svc, records } = await service();
    const out = await svc.execute(
      { code: "return (;", language: "javascript" },
      CTX,
    );
    assert.isFalse(out.ok);
    assert.equals(out.error!.type, "syntax_error");
    refute.contains(audits(records), "execution.import_denied");
    refute.contains(audits(records), "execution.resource_limit");
    const failed = records().find((r) => r.event === "execution.failed")!;
    assert.equals(failed.get("errorType"), "syntax_error");
  });

  it("should refuse TypeScript with type errors, but not type-check JavaScript", async function () {
    const check = sinon.stub(AgentTypeChecker.prototype, "check").returns([
      {
        line: 2,
        column: 5,
        code: 2339,
        message: "Property 'nmae' does not exist",
      },
    ]);
    const exec = executor();
    const { svc } = await service({
      executor: exec,
      config: config({ execution: { typecheck: true } }),
    });
    const out = await svc.execute({ code: "return x.nmae;" }, CTX);
    assert.equals(out.error!.type, "type_error");
    assert.match(
      out.error!.message,
      /1 type error\(s\): Property 'nmae'.*line 2/,
    );
    assert.equals(out.error!.diagnostics!.length, 1);
    assert.match(out.hint!, /search \{ id \}/);
    assert.equals(exec.execute.callCount, 0);

    await svc.execute({ code: "return 1;", language: "javascript" }, CTX);
    assert.equals(check.callCount, 1, "JavaScript is not type-checked");
    assert.equals(exec.execute.callCount, 1);
  });

  it("should refuse an execution when every slot and the queue are taken", async function () {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const exec = executor(async () => {
      await blocked;
      return { ok: true, result: 1 };
    });
    const { svc, records } = await service({
      executor: exec,
      config: config({ execution: { maxConcurrent: 1, maxQueue: 0 } }),
    });
    const first = svc.execute({ code: "return 1;" }, CTX);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await svc.execute({ code: "return 2;" }, CTX);
    assert.equals(second.error!.reason, "executor_busy");
    const limit = records().find(
      (r) => r.event === "execution.resource_limit",
    )!;
    assert.equals(limit.get("limit"), "maxConcurrent");
    release();
    assert.isTrue((await first).ok);
    // The slot is free again once the first execution finishes.
    assert.isTrue((await svc.execute({ code: "return 3;" }, CTX)).ok);
  });

  it("should free the slot when the executor throws", async function () {
    let calls = 0;
    const exec = executor(async () => {
      calls++;
      if (calls === 1) {
        throw new Error("executor crashed");
      }
      return { ok: true, result: 1 };
    });
    const { svc } = await service({
      executor: exec,
      config: config({ execution: { maxConcurrent: 1, maxQueue: 0 } }),
    });
    await assert.rejects(
      svc.execute({ code: "return 1;" }, CTX),
      match({ message: "executor crashed" }),
    );
    assert.isTrue((await svc.execute({ code: "return 1;" }, CTX)).ok);
  });

  it("should audit capabilities the sandbox denied", async function () {
    for (const [capability, expected] of [
      ["net", "net"],
      [undefined, "unknown"],
    ]) {
      const { svc, records } = await service({
        executor: executor(async () => ({
          error: {
            type: "permission_denied",
            reason: "sandbox_capability_denied",
            capability,
            message: "denied",
          },
        })),
      });
      await svc.execute({ code: "return 1;" }, CTX);
      const denied = records().find(
        (r) => r.event === "execution.capability_denied",
      )!;
      assert.equals(denied.get("capability"), expected);
    }
    const other = await service({
      executor: executor(async () => ({
        error: {
          type: "permission_denied",
          reason: "authorization_denied",
          message: "not permitted",
        },
      })),
    });
    await other.svc.execute({ code: "return 1;" }, CTX);
    refute.contains(audits(other.records), "execution.capability_denied");
  });

  it("should audit results over the output limit or of unsupported types", async function () {
    for (const type of ["output_limit", "unsupported_result"] as const) {
      const { svc, records } = await service({
        executor: executor(async () => ({ error: { type, message: type } })),
      });
      const out = await svc.execute({ code: "return 1;" }, CTX);
      assert.equals(out.error!.type, type);
      const limit = records().find(
        (r) => r.event === "execution.resource_limit",
      )!;
      assert.equals(limit.get("limit"), type);
    }
  });

  it("should refuse execution when its audit record cannot be written, and every execution after", async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-svc-"));
    const opFile = path.join(dir, "op.log");
    const logs = new Logs({
      file: opFile,
      auditFile: path.join(dir, "audit.log"),
      auditFailClosed: true,
    });
    const exec = executor();
    const { svc } = await service({ executor: exec, logs });
    // Auditing works at start-up, then the audit destination fails.
    const writeSync = fs.writeSync;
    sinon.stub(fs, "writeSync").callsFake(((
      fd: number,
      data: string,
      ...rest: never[]
    ) => {
      if (String(data).includes('"class_uid"')) {
        throw Object.assign(new Error("disk gone"), { code: "EIO" });
      }
      return writeSync(fd, data, ...rest);
    }) as typeof fs.writeSync);
    // The execution request cannot be recorded: this call is refused...
    const first = await svc.execute({ code: "return 1;" }, CTX);
    assert.equals(first.error!.type, "audit_unavailable");
    // ...and so is every later one, before anything is recorded.
    const second = await svc.execute({ code: "return 1;" }, CTX);
    assert.equals(second.error!.type, "audit_unavailable");
    assert.equals(exec.execute.callCount, 0);
    sinon.restore();
    const failed = readLogRecords(opFile).filter(
      (r) => r.event === "execution.failed",
    );
    assert.equals(failed.length, 2);
  });

  it("should keep executing when auditing fails but fail-closed is off", async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-svc-"));
    const logs = new Logs({
      file: path.join(dir, "op.log"),
      // No such file descriptor, so every audit write fails.
      auditFile: "fd:1000000",
    });
    const { svc } = await service({ logs });
    assert.isTrue((await svc.execute({ code: "return 1;" }, CTX)).ok);
  });
});
