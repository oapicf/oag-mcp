"use strict";
/**
 * Structured logging verification: category routing, audit independence
 * from the operational level, per-operation authorisation records, secret
 * redaction, correlation under concurrency, stdout purity for stdio and
 * audit-destination failure policy.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { Logs } from "../lib/logger.js";
import type { PreparedSdk } from "../lib/prepare/prepare.js";
import {
  BIN,
  LOCAL,
  SECRET_ENV,
  SERVE_ARGS,
  defaultPrepared,
  configFor,
  service,
  upstreamAuthConfig,
  workDir,
  writeConfig,
} from "./helpers/env.js";
import { type MockApi, startMockApi } from "./helpers/mock-api.js";
import { type AuthServer, startAuthServer } from "./helpers/auth-server.js";

const { assert, refute } = referee;

let api: MockApi;
let auth: AuthServer;
let art: PreparedSdk;

before(async function () {
  this.timeout(120000);
  art = await defaultPrepared();
  auth = await startAuthServer();
  api = await startMockApi({ oauthTokens: auth.upstreamTokens });
});

after(async function () {
  await api?.close();
  await auth?.close();
});

const lines = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Drive `oag-mcp serve --transport stdio` with raw JSON-RPC lines. */
async function stdioSession(
  args: string[],
  messages: unknown[],
  env: Record<string, string> = {},
): Promise<{
  stdout: string;
  stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC payloads
  responses: Array<Record<string, any>>;
}> {
  const child = spawn(
    process.execPath,
    [BIN, "serve", ...SERVE_ARGS, "--transport", "stdio", ...args],
    {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC payloads
  const responses: Array<Record<string, any>> = [];
  for (const m of messages) {
    child.stdin.write(`${JSON.stringify(m)}\n`);
    const id = (m as { id?: number }).id;
    if (id !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no response to ${id}: ${stderr}`)),
          30000,
        );
        const check = () => {
          const found = stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .find((r) => r.id === id);
          if (found) {
            clearTimeout(timer);
            child.stdout.off("data", check);
            responses.push(found);
            resolve();
          }
        };
        child.stdout.on("data", check);
        check();
      });
    }
  }
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  return { stdout, stderr, responses };
}

const INIT = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw", version: "1" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];
const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("logging - stdio sessions", function () {
  it("should keep stdout exclusively for MCP protocol traffic, even with pretty debug logs", async function () {
    const dir = workDir("stdout");
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(),
    });
    const { stdout, stderr, responses } = await stdioSession(
      ["--config", config, "--log-level", "debug", "--log-format", "pretty"],
      [
        ...INIT,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        call(3, "search", { query: "owners" }),
        call(4, "execute", {
          code: `console.log("hello"); return (await sdk.OwnersApi.listOwners({})).length;`,
        }),
      ],
      SECRET_ENV,
    );
    for (const line of stdout.split("\n").filter(Boolean)) {
      const msg = JSON.parse(line);
      assert.equals(msg.jsonrpc, "2.0", line);
    }
    assert.equals(
      responses[1].result.tools.map((t: { name: string }) => t.name),
      ["search", "execute"],
    );
    assert.equals(responses[3].result.structuredContent.result, 3);
    assert.match(stderr, /server\.ready/);
    assert.match(stderr, /authorization\.allowed/);
    refute.contains(stdout, "server.ready");
  });

  it("should route categories to separate files and keep auditing when operational logs are silenced", async function () {
    const dir = workDir("routing");
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(),
    });
    const op = path.join(dir, "op.log");
    const audit = path.join(dir, "audit.log");
    await stdioSession(
      [
        "--config",
        config,
        "--log-level",
        "silent",
        "--log-file",
        op,
        "--audit-log-file",
        audit,
      ],
      [
        ...INIT,
        call(2, "execute", {
          code: `return (await sdk.PetsApi.listPets({ limit: 1 })).length;`,
        }),
      ],
      SECRET_ENV,
    );
    assert.equals(lines(op), []);
    const auditRecords = lines(audit);
    assert.greater(auditRecords.length, 3);
    for (const r of auditRecords) {
      assert.equals(r.logCategory, "security_audit");
      assert.isString(r.event);
      assert.isString(r.outcome);
    }
    assert.contains(
      auditRecords.map((r) => r.event),
      "authorization.allowed",
    );

    const op2 = path.join(dir, "op2.log");
    const audit2 = path.join(dir, "audit2.log");
    await stdioSession(
      ["--config", config, "--log-file", op2, "--audit-log-file", audit2],
      [...INIT, call(2, "search", {})],
      SECRET_ENV,
    );
    for (const r of lines(op2)) {
      assert.equals(r.logCategory, "operational");
    }
    assert.contains(
      lines(op2).map((r) => r.event),
      "search.completed",
    );
    assert.contains(
      lines(op2).map((r) => r.event),
      "server.ready",
    );
  });

  it("should refuse execute calls when the audit destination fails in fail-closed mode", async function () {
    const dir = workDir("failclosed");
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(),
    });
    const exec = call(2, "execute", { code: `return 1;` });
    const closed = await stdioSession(
      ["--config", config, "--audit-log-file", "fd:99", "--audit-fail-closed"],
      [...INIT, exec],
      SECRET_ENV,
    );
    assert.equals(
      closed.responses[1].result.structuredContent.error.type,
      "audit_unavailable",
    );
    assert.match(closed.stderr, /logging\.destination_failed/);
    const open = await stdioSession(
      ["--config", config, "--audit-log-file", "fd:99"],
      [...INIT, exec],
      SECRET_ENV,
    );
    assert.equals(open.responses[1].result.structuredContent.result, 1);
  });
});

describe("logging - records from executions", function () {
  it("should record an authorization audit event for each attempted SDK operation, correlated per execution", async function () {
    const file = path.join(workDir("correlation"), "all.log");
    const logs = new Logs({ file, auditFile: file });
    const svc = await service(art, configFor(api, {}, auth), logs);
    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map((id) =>
        svc.execute(
          {
            code: `const p = await sdk.PetsApi.getPetById({ petId: ${id} });\nconst v = await sdk.PetsApi.listPetVisits({ petId: ${id} });\nreturn [p.name, v.length];`,
          },
          { ...LOCAL, requestId: `req_${id}` },
        ),
      ),
    );
    const records = lines(file);
    for (const [i, r] of runs.entries()) {
      assert.isTrue(r.ok);
      const mine = records.filter((x) => x.executionId === r.executionId);
      const decisions = mine.filter((x) => x.event === "authorization.allowed");
      assert.equals(decisions.map((d) => d.operation).sort(), [
        "PetsApi.getPetById",
        "PetsApi.listPetVisits",
      ]);
      for (const d of mine) {
        assert.equals(d.requestId, `req_${i + 1}`);
        assert.equals(d.principalId, "local:test");
      }
      assert.equals(
        mine.filter((x) => x.event === "upstream.call.completed").length,
        2,
      );
    }
  });

  it("should redact secrets from logs of successful and failed requests, including query api keys", async function () {
    const file = path.join(workDir("redaction"), "all.log");
    const logs = new Logs({ file, auditFile: file, level: "trace" });
    const svc = await service(art, configFor(api, {}, auth), logs);
    const codes = [
      `return await sdk.OwnersApi.listOwners({ city: "Melbourne" });`,
      `return await sdk.PetsApi.getPetById({ petId: 404 });`,
      `return await sdk.StoreApi.getStoreInventory({ headers: { "x-echo-auth": "1" } });`,
      `return await sdk.PetsApi.createPet({ newPet: { name: "S", species: "dog" } });`,
      `await sdk.AdminApi.deletePet({ petId: 1 }); return 1;`,
      `throw new Error("agent says ${SECRET_ENV.PC_API_KEY}");`,
    ];
    for (const code of codes) {
      await svc.execute({ code }, LOCAL);
    }
    const text = fs.readFileSync(file, "utf8");
    for (const secret of [
      ...Object.values(SECRET_ENV),
      ...auth.upstreamTokens.keys(),
    ]) {
      refute.contains(text, secret);
    }
    refute.match(text, /api_key=[^[]/);
    // Agent code, queries and API bodies are not logged.
    refute.contains(text, "Melbourne");
    refute.contains(text, "agent says");
  });
});
