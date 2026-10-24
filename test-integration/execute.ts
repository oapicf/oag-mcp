"use strict";
/**
 * Verification 2–6: search returns callable methods, execute runs the real
 * generated SDK against the mock API, multi-call workflows, useful errors,
 * and sandbox limits, isolation and denied capabilities.
 */
import referee from "@sinonjs/referee";

import type { OagMcpService } from "../lib/runtime/service.js";
import {
  LOCAL,
  SDK_VARIANT,
  SPEC,
  fileLogs,
  prepared,
  defaultPrepared,
  configFor,
  service,
} from "./helpers/env.js";
import { type MockApi, PETS, startMockApi } from "./helpers/mock-api.js";
import { type AuthServer, startAuthServer } from "./helpers/auth-server.js";

const { assert, refute } = referee;

let api: MockApi;
let auth: AuthServer;
let svc: OagMcpService;

before(async function () {
  this.timeout(120000);
  auth = await startAuthServer();
  api = await startMockApi({ oauthTokens: auth.upstreamTokens });
  svc = await service(
    await defaultPrepared(),
    configFor(
      api,
      {
        execution: {
          timeoutMs: 5000,
          maxResultBytes: 4096,
          maxLogBytes: 512,
          maxSdkCalls: 50,
        },
      },
      auth,
    ),
  );
});

after(async function () {
  await api?.close();
  await auth?.close();
});

const run = (code: string, extra: Record<string, unknown> = {}) =>
  svc.execute({ code, ...extra }, LOCAL);

describe("execute - search and binding agreement", function () {
  it("should expose every searchable method on the sdk binding", async function () {
    const ids = svc.index.records.map((r) => r.id);
    const res = await run(
      `const ids = ${JSON.stringify(ids)};\nconst s = sdk as unknown as Record<string, Record<string, unknown>>;\nreturn ids.filter((id) => { const [c, m] = id.split("."); return typeof s[c]?.[m] !== "function"; });`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(res.result, []);
  });

  it("should return the exact signature and sdk path that execute accepts", async function () {
    const found = svc.search({ query: "list pets by species" }, LOCAL) as {
      results: Array<{ id: string; sdkPath: string }>;
    };
    assert.equals(found.results[0].id, "PetsApi.listPets");
    const detail = svc.search({ id: "PetsApi.listPets" }, LOCAL) as {
      method: { example: string; signature: string; referencedTypes: string[] };
    };
    assert.match(
      detail.method.signature,
      /listPets\(requestParameters\?: ListPetsRequest/,
    );
    const res = await run(detail.method.example);
    assert.isTrue(res.ok, JSON.stringify(res.error));
  });

  it("should browse capabilities when no query is given", function () {
    const out = svc.search({}, LOCAL) as {
      apis: Array<{ api: string; methodCount: number }>;
    };
    assert.equals(
      out.apis.map((a) => a.api),
      ["AdminApi", "OwnersApi", "PetsApi", "StoreApi"],
    );
    assert.equals(
      out.apis.reduce((s, a) => s + a.methodCount, 0),
      11,
    );
  });

  it("should keep search output bounded", function () {
    const out = JSON.stringify(svc.search({ query: "pet", limit: 20 }, LOCAL));
    assert.less(out.length, 24000);
  });
});

describe("execute - real SDK against the mock API", function () {
  it("should call the generated SDK and return its parsed models", async function () {
    const res = await run(
      `const pet = await sdk.PetsApi.getPetById({ petId: 3 });\nreturn { name: pet.name, born: pet.birthDate, isDate: pet.birthDate instanceof Date };`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    // birthDate was converted to a Date by the SDK's model code, then serialised.
    assert.equals(res.result, {
      name: "Pepper",
      born: "2012-03-15T00:00:00.000Z",
      isDate: true,
    });
    const req = api.requests.at(-1)!;
    assert.equals(req.path, "/v1/pets/3");
  });

  it("should run a multi-call workflow that filters intermediate data into a compact result", async function () {
    const before = api.requests.length;
    const res = await run(`
const pets = await sdk.PetsApi.listPets({});
const unvaccinated = pets.filter((p) => !p.vaccinated);
const visits = await Promise.all(unvaccinated.map((p) => sdk.PetsApi.listPetVisits({ petId: p.id })));
const owners = await sdk.OwnersApi.listOwners({});
const ownerName = new Map(owners.map((o) => [o.id, o.name]));
const report = unvaccinated.map((p, i) => ({
  pet: p.name,
  owner: ownerName.get(p.ownerId ?? -1) ?? "unknown",
  spentCents: visits[i].reduce((s, v) => s + (v.costCents ?? 0), 0),
}));
console.log("checked", pets.length, "pets");
return { count: report.length, totalCents: report.reduce((s, r) => s + r.spentCents, 0), report };
`);
    assert.isTrue(res.ok, JSON.stringify(res.error));
    const unvaccinated = PETS.filter((p) => !p.vaccinated);
    const result = res.result as {
      count: number;
      totalCents: number;
      report: Array<{ pet: string; owner: string }>;
    };
    assert.equals(result.count, unvaccinated.length);
    assert.equals(result.report[0], {
      pet: "Biscuit",
      owner: "Ada",
      spentCents: 5100 + 3000,
    });
    assert.equals(res.stats.sdkCalls, 2 + unvaccinated.length);
    assert.equals(api.requests.length - before, 2 + unvaccinated.length);
    assert.equals(res.logs, [{ level: "log", message: "checked 12 pets" }]);
  });

  it("should send request bodies through the SDK's serialisation", async function () {
    const res = await run(
      `return await sdk.PetsApi.createPet({ newPet: { name: "Nova", species: "cat", ownerId: 2 } });`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(res.result, {
      id: 100,
      name: "Nova",
      species: "cat",
      ownerId: 2,
    });
    const req = api.requests.filter((r) => r.method === "POST").at(-1)!;
    assert.equals(JSON.parse(req.body!), {
      name: "Nova",
      species: "cat",
      ownerId: 2,
    });
    assert.equals(req.headers["content-type"], "application/json");
  });

  it("should work with positional SDK signatures", async function () {
    const variant = await service(
      await prepared("variant", { spec: SPEC, sdk: SDK_VARIANT }),
      configFor(api, {}, auth),
    );
    const res = await variant.execute(
      {
        code: `const p = await sdk.PetsApi.getPetById(2);\nconst list = await sdk.PetsApi.listPets("bird", 1);\nreturn [p.name, list.map((x) => x.name)];`,
      },
      LOCAL,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(res.result, ["Mochi", ["Pepper"]]);
  });

  it("should accept JavaScript without type checking", async function () {
    const res = await run(
      `const p = await sdk.PetsApi.listPets({ limit: 1 });\nreturn p[0].name;`,
      { language: "javascript" },
    );
    assert.isTrue(res.ok);
    assert.equals(res.result, "Biscuit");
  });

  it("should hint when no value is returned", async function () {
    const res = await run(`await sdk.AdminApi.healthGet();`);
    assert.isTrue(res.ok);
    assert.isNull(res.result);
    assert.match(res.hint, /return/);
  });
});

describe("execute - feedback for invalid code and API errors", function () {
  it("should return type errors with agent line numbers before running", async function () {
    const before = api.requests.length;
    const res = await run(
      `const pets = await sdk.PetsApi.listPets({ limit: 5 });\nreturn pets.map((p) => p.nmae);`,
    );
    assert.isFalse(res.ok);
    assert.equals(res.error!.type, "type_error");
    assert.equals(res.error!.diagnostics![0].line, 2);
    assert.match(res.error!.diagnostics![0].message, /nmae/);
    assert.equals(api.requests.length, before);
  });

  it("should flag unknown SDK methods as type errors", async function () {
    const res = await run(`return await sdk.PetsApi.deleteEverything();`);
    assert.equals(res.error!.type, "type_error");
    assert.match(res.error!.message, /deleteEverything/);
  });

  it("should return syntax errors", async function () {
    const res = await run(`const x = ;`);
    assert.equals(res.error!.type, "syntax_error");
    assert.equals(res.error!.diagnostics![0].line, 1);
  });

  it("should return structured API errors with status and body", async function () {
    const res = await run(
      `const a = 1;\nreturn await sdk.PetsApi.getPetById({ petId: 404 });`,
    );
    assert.isFalse(res.ok);
    assert.equals(res.error!.type, "api_error");
    assert.equals(res.error!.status, 404);
    assert.match(res.error!.body as string, /pet 404 not found/);
    assert.equals(res.error!.line, 2);
  });

  it("should report SDK validation errors for missing required parameters", async function () {
    const res = await run(`return await sdk.PetsApi.getPetById({} as never);`);
    assert.equals(res.error!.type, "sdk_error");
    assert.equals(res.error!.field, "petId");
  });

  it("should report runtime errors thrown by agent code", async function () {
    const res = await run(`throw new RangeError("boom");`);
    assert.equals(res.error!.type, "runtime_error");
    assert.equals(res.error!.name, "RangeError");
    assert.equals(res.error!.message, "boom");
  });
});

describe("execute - limits, isolation and denied capabilities", function () {
  it("should terminate code that exceeds the time limit", async function () {
    const started = Date.now();
    const res = await run(`while (true) {}`, {
      language: "javascript",
      timeoutMs: 1000,
    });
    assert.equals(res.error!.type, "timeout");
    assert.less(Date.now() - started, 4000);
  });

  it("should terminate slow API workflows at the time limit", async function () {
    const res = await run(
      `return await sdk.AdminApi.slowEndpoint({ delayMs: 5000 });`,
      { timeoutMs: 800 },
    );
    assert.equals(res.error!.type, "timeout");
  });

  it("should enforce the result size limit", async function () {
    const res = await run(`return "x".repeat(10000);`);
    assert.equals(res.error!.type, "output_limit");
  });

  it("should bound console output", async function () {
    const res = await run(
      `for (let i = 0; i < 1000; i++) console.log("line", i);\nreturn 1;`,
    );
    assert.isTrue(res.ok);
    assert.isTrue(res.logsTruncated);
    assert.less(res.logs.map((l) => l.message).join("").length, 600);
  });

  it("should enforce the memory limit", async function () {
    this.timeout(30000);
    const res = await run(
      `const a: string[] = [];\nwhile (true) a.push("x".repeat(1024 * 1024) + a.length);`,
      { timeoutMs: 20000 },
    );
    assert.isFalse(res.ok);
    assert.equals(res.error!.type, "resource_limit");
  });

  it("should reject unsupported result values clearly", async function () {
    const res = await run(`return new Map([["a", 1]]);`);
    assert.equals(res.error!.type, "unsupported_result");
    assert.match(res.error!.message, /Array\.from/);
    const big = await run(`return 10n;`, { language: "javascript" });
    assert.equals(big.error!.type, "unsupported_result");
  });

  it("should isolate state between executions", async function () {
    await run(`(globalThis as any).leak = "from-first";\nreturn 1;`);
    const res = await run(`return (globalThis as any).leak ?? null;`);
    assert.isNull(res.result);
  });

  it("should deny filesystem, network, environment, subprocess, FFI and system access", async function () {
    const cases: Array<[string, string]> = [
      [`return Deno.readTextFileSync("/etc/hostname");`, "read"],
      [
        `Deno.writeTextFileSync("/tmp/oag-mcp-escape", "x"); return 1;`,
        "write",
      ],
      [`return await fetch("https://example.com/");`, "net"],
      [`return Deno.env.get("PC_API_KEY") ?? "none";`, "env"],
      [
        `return await new Deno.Command("/bin/sh", { args: ["-c", "id"] }).output();`,
        "run",
      ],
      [
        `return process.getBuiltinModule("node:child_process").execSync("/bin/sh -c id").toString();`,
        "run|env",
      ],
      [
        `return process.getBuiltinModule("node:fs").readFileSync("/etc/hostname", "utf8");`,
        "read",
      ],
      [`return Deno.dlopen("libc.so.6", {});`, "ffi"],
      [`return Deno.hostname();`, "sys"],
      [`return globalThis.process.env.PC_API_KEY;`, "env"],
    ];
    for (const [code, capability] of cases) {
      const res = await run(code, { language: "javascript" });
      assert.isFalse(res.ok, code);
      assert.equals(res.error!.type, "permission_denied", code);
      assert.match(
        res.error!.capability,
        new RegExp(`^(${capability})$`),
        code,
      );
    }
  });

  it("should deny eval, Function and Worker based escapes", async function () {
    const evalRes = await run(`return eval("1 + 1");`, {
      language: "javascript",
    });
    assert.equals(evalRes.error!.capability, "eval");
    const fnRes = await run(`return new Function("return 1")();`, {
      language: "javascript",
    });
    assert.equals(fnRes.error!.capability, "eval");
    const worker = await run(`return typeof Worker;`, {
      language: "javascript",
    });
    assert.equals(worker.result, "undefined");
  });

  it("should reject imports before execution", async function () {
    for (const code of [
      `const fs = await import("node:fs");`,
      `import fs from "node:fs";`,
      `return require("fs");`,
    ]) {
      const res = await run(code, { language: "javascript" });
      assert.equals(res.error!.type, "permission_denied", code);
      assert.equals(res.error!.reason, "import_not_allowed", code);
    }
  });

  it("should not let agent code reach SDK configuration or credentials", async function () {
    const res = await run(
      `const s = sdk as any;\nconst keys = Object.keys(s.PetsApi);\nconst frozen = Object.isFrozen(s) && Object.isFrozen(s.PetsApi);\nlet configuration = "none";\ntry { configuration = JSON.stringify((s.PetsApi.listPets as any).configuration ?? null); } catch {}\nreturn { keys, frozen, configuration, env: typeof (globalThis as any).Deno?.env };`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    const r = res.result as {
      keys: string[];
      frozen: boolean;
      configuration: string;
    };
    assert.equals(r.keys.sort(), [
      "createPet",
      "getPetById",
      "listLegacyPets",
      "listPetVisits",
      "listPets",
    ]);
    assert.isTrue(r.frozen);
    assert.equals(r.configuration, "null");
    refute.contains(JSON.stringify(res), process.env.PC_API_KEY!);
  });

  it("should run concurrent executions independently", async function () {
    const results = await Promise.all(
      [1, 2, 3, 4].map((id) =>
        run(
          `const p = await sdk.PetsApi.getPetById({ petId: ${id} });\nreturn p.name;`,
        ),
      ),
    );
    assert.equals(
      results.map((r) => r.result),
      ["Biscuit", "Mochi", "Pepper", "Nori"],
    );
    assert.equals(new Set(results.map((r) => r.executionId)).size, 4);
  });
});

describe("execute - forged bridge messages from agent code", function () {
  // Agent code can write to the sandbox's stdout directly, bypassing the SDK
  // binding, so it can forge bridge `fetch` messages with any binding tag,
  // URL, method and headers. The broker must treat every message as untrusted:
  // a forged message may do nothing a legitimate SDK call could not.
  let guarded: OagMcpService;
  let audit: ReturnType<typeof fileLogs>;

  before(async function () {
    this.timeout(60000);
    audit = fileLogs("forged-bridge");
    guarded = await service(
      await defaultPrepared(),
      configFor(
        api,
        {
          authorization: {
            default: "deny",
            rules: [{ id: "get-only", allow: ["method:GET"] }],
          },
        },
        auth,
      ),
      audit.logs,
    );
  });

  /**
   * Run agent code that writes raw bridge messages to stdout, then waits long
   * enough for the host to act on them before reporting its result.
   */
  const forge = (messages: Array<Record<string, unknown>>) =>
    guarded.execute(
      {
        language: "javascript",
        code: `const out = new TextEncoder();
for (const m of ${JSON.stringify(messages)}) {
  Deno.stdout.writeSync(out.encode(JSON.stringify({ type: "fetch", rid: 9000, body: null, headers: {}, ...m }) + "\\n"));
}
await new Promise((r) => setTimeout(r, 750));
return "sent";`,
      },
      LOCAL,
    );

  const auditFor = (executionId: string, event: string) => {
    audit.logs.flush();
    return audit
      .records()
      .filter((r) => r.executionId === executionId && r.event === event);
  };

  it("should refuse a forged request for an operation the caller may not call", async function () {
    // The legitimate route is denied too, so forging gains nothing.
    const direct = await guarded.execute(
      { code: `await sdk.AdminApi.deletePet({ petId: 1 });\nreturn 1;` },
      LOCAL,
    );
    assert.equals(direct.error!.reason, "authorization_denied");

    const before = api.requests.length;
    const res = await forge([
      {
        binding: "AdminApi.deletePet",
        method: "DELETE",
        url: `${api.baseUrl}/pets/1`,
      },
    ]);
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(api.requests.length, before, "nothing reached the API");
    const denied = auditFor(res.executionId, "authorization.denied");
    assert.equals(denied.length, 1);
    assert.equals(denied[0].operation, "AdminApi.deletePet");
    assert.equals(denied[0].outcome, "denied");
  });

  it("should refuse a forged request that does not match its claimed operation", async function () {
    const before = api.requests.length;
    const res = await forge([
      // An allowed GET binding used to smuggle a DELETE.
      {
        binding: "PetsApi.getPetById",
        method: "DELETE",
        url: `${api.baseUrl}/pets/1`,
      },
      // An allowed binding pointed at another path of the API.
      {
        binding: "PetsApi.listPets",
        method: "GET",
        url: `${api.baseUrl}/store/inventory`,
      },
      // An allowed binding pointed at another host (SSRF).
      {
        binding: "PetsApi.listPets",
        method: "GET",
        url: "http://169.254.169.254/v1/pets",
      },
    ]);
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(api.requests.length, before, "nothing reached the API");
    const reasons = auditFor(res.executionId, "network.destination_denied")
      .map((r) => r.reason)
      .sort();
    assert.equals(reasons, [
      "method_mismatch",
      "origin_not_allowed",
      "path_mismatch",
    ]);
  });

  it("should refuse a forged request with an unknown binding", async function () {
    const before = api.requests.length;
    const res = await forge([
      { binding: "EvilApi.steal", method: "GET", url: `${api.baseUrl}/pets` },
    ]);
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(api.requests.length, before, "nothing reached the API");
    const violations = auditFor(
      res.executionId,
      "execution.boundary_violation",
    );
    assert.equals(violations.length, 1);
    assert.equals(violations[0].reason, "unknown_binding");
    assert.equals(violations[0].binding, "EvilApi.steal");
  });

  it("should replace credentials in a forged request with the configured ones", async function () {
    const before = api.requests.length;
    const res = await forge([
      {
        binding: "PetsApi.listPets",
        method: "GET",
        url: `${api.baseUrl}/pets?limit=1`,
        headers: {
          authorization: "Bearer forged-token",
          "x-api-key": "forged-key",
        },
      },
    ]);
    assert.isTrue(res.ok, JSON.stringify(res.error));
    const reached = api.requests.slice(before);
    assert.equals(
      reached.map((r) => `${r.method} ${r.path}`),
      ["GET /v1/pets"],
    );
    assert.equals(reached[0].headers["x-api-key"], process.env.PC_API_KEY);
    refute.contains(JSON.stringify(reached[0].headers), "forged");
    const stripped = auditFor(
      res.executionId,
      "credential.agent_supplied_stripped",
    );
    assert.equals(stripped.length, 1);
    assert.equals((stripped[0].fields as string[]).sort(), [
      "authorization",
      "x-api-key",
    ]);
    // The reply went to an rid the runner never issued, so it was ignored.
    assert.equals(res.result, "sent");
  });
});
