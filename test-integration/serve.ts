"use strict";
/**
 * Serving from --spec and --sdk: start-up preparation of every
 * supported input, accurate indexing, one preparation per process reused by
 * every call, actionable preparation errors, an unchanged SDK, and removal
 * of the private workspace on shutdown and start-up failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import referee from "@sinonjs/referee";

import { OagMcpError } from "../lib/errors.js";
import { prepareSdk } from "../lib/prepare/prepare.js";
import { WORKSPACE_PREFIX } from "../lib/prepare/workspace.js";
import { serve } from "../lib/runtime/serve.js";
import { sha256Tree } from "../lib/util/hash.js";
import {
  BIN,
  LOCAL,
  SDK_726,
  SDK_TGZ,
  SDK_VARIANT,
  SECRET_ENV,
  SPEC,
  defaultPrepared,
  fileLogs,
  prepared,
  configFor,
  service,
  startHttpServer,
  upstreamAuthConfig,
  workDir,
  writeConfig,
} from "./helpers/env.js";
import { startMockApi } from "./helpers/mock-api.js";

const { assert, refute } = referee;

const EXPECTED_IDS = [
  "AdminApi.deletePet",
  "AdminApi.healthGet",
  "AdminApi.slowEndpoint",
  "OwnersApi.listOwners",
  "PetsApi.createPet",
  "PetsApi.getPetById",
  "PetsApi.listLegacyPets",
  "PetsApi.listPetVisits",
  "PetsApi.listPets",
  "StoreApi.getExternalDocs",
  "StoreApi.getStoreInventory",
];

/** Workspaces currently present under a root. */
function workspaces(root: string): string[] {
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((n) => n.startsWith(WORKSPACE_PREFIX))
    : [];
}

/** Expect a preparation failure with a code and leave no workspace. */
async function expectPrepareError(
  opts: { spec: string; sdk: string; sdkLayout?: "compiled" | "source" },
  code: string,
): Promise<OagMcpError> {
  const root = workDir("ws-fail");
  const { logs, records } = fileLogs("fail");
  try {
    await prepareSdk({ ...opts, workspaceRoot: root, logs });
  } catch (e) {
    const err = e as OagMcpError;
    assert.equals(err.code, code, err.message);
    assert.equals(workspaces(root), [], "workspace removed on failure");
    const failed = records().find((r) => r.event === "prepare.failed");
    assert.equals(failed?.errorCode, code);
    return err;
  }
  throw new Error(`expected ${code}`);
}

/** Copy the default SDK fixture somewhere writable. */
function sdkCopy(name: string): string {
  const dir = path.join(workDir(name), "sdk");
  fs.cpSync(SDK_726, dir, { recursive: true });
  return dir;
}

describe("prepare - supported SDK inputs", function () {
  it("should prepare a source SDK directory and index every method accurately", async function () {
    const p = await defaultPrepared();
    assert.equals(p.info.target.generator, "typescript-fetch");
    assert.equals(p.info.target.oagVersion, "7.26.0");
    assert.equals(p.info.target.sdkLayout, "source");
    assert.equals(p.info.inputs.sdk.kind, "directory");
    assert.match(p.info.inputs.spec.sha256, /^[0-9a-f]{64}$/);
    assert.equals(p.records.map((r) => r.id).sort(), EXPECTED_IDS);
    const visits = p.records.find((r) => r.id === "PetsApi.listPetVisits")!;
    // operationId differs from the generated method name.
    assert.equals(visits.operationId, "list-pet-visits");
    assert.equals(visits.httpMethod, "GET");
    assert.equals(visits.path, "/pets/{petId}/visits");
    assert.equals(visits.requiredArguments, ["petId"]);
    assert.match(
      visits.signature,
      /^listPetVisits\(requestParameters: ListPetVisitsRequest/,
    );
    assert.equals(visits.auth.alternatives.length, 2);
    // The operation without operationId is still bound by method and path.
    assert.equals(
      p.records.find((r) => r.id === "AdminApi.healthGet")!.path,
      "/health",
    );
    for (const f of [
      "sdk/sdk.bundle.js",
      "sdk/sdk-binding.d.ts",
      "sdk/types/index.d.ts",
      "executor/runner.js",
    ]) {
      assert(fs.existsSync(path.join(p.workspaceDir, f)), f);
    }
    assert(p.workspaceDir.startsWith(os.tmpdir()));
  });

  it("should prepare a packaged SDK archive in both compiled and source layouts", async function () {
    const compiled = await prepared("tgz-compiled", {
      spec: SPEC,
      sdk: SDK_TGZ,
      sdkLayout: "compiled",
    });
    const source = await prepared("tgz-source", { spec: SPEC, sdk: SDK_TGZ });
    assert.equals(compiled.info.target.sdkLayout, "compiled");
    assert.equals(compiled.info.inputs.sdk.kind, "archive");
    assert.equals(source.info.target.sdkLayout, "source");
    assert.equals(compiled.records.map((r) => r.id).sort(), EXPECTED_IDS);
    assert.equals(
      compiled.records.map((r) => r.signature).sort(),
      (await defaultPrepared()).records.map((r) => r.signature).sort(),
    );
    // Archives are extracted inside the private workspace.
    assert(fs.existsSync(path.join(compiled.workspaceDir, "input", "package")));
  });

  it("should support the generator option variant", async function () {
    const variant = await prepared("variant", { spec: SPEC, sdk: SDK_VARIANT });
    assert.equals(variant.info.target.options.withInterfaces, true);
    assert.equals(variant.records.map((r) => r.id).sort(), EXPECTED_IDS);
    assert.match(
      variant.records.find((r) => r.id === "PetsApi.getPetById")!.signature,
      /getPetById\(petId: number/,
    );
  });

  it("should never modify or add files to the supplied SDK", async function () {
    const sdk = sdkCopy("unmodified");
    const list = () =>
      fs.readdirSync(sdk, { recursive: true }).map(String).sort();
    const beforeHash = sha256Tree(sdk);
    const beforeFiles = list();
    const p = await prepareSdk({ spec: SPEC, sdk, logs: fileLogs().logs });
    p.cleanup();
    // A compiled package exercises the CommonJS shim path as well.
    const compiledDir = path.join(workDir("compiled-in-place"), "pkg");
    await (
      await import("../lib/prepare/sdk-input.js")
    ).extractArchive(SDK_TGZ, compiledDir);
    const pkgRoot = path.join(compiledDir, "package");
    const compiledBefore = sha256Tree(pkgRoot);
    const compiledFiles = fs.readdirSync(pkgRoot, { recursive: true }).length;
    const q = await prepareSdk({
      spec: SPEC,
      sdk: pkgRoot,
      sdkLayout: "compiled",
      logs: fileLogs().logs,
    });
    q.cleanup();
    assert.equals(sha256Tree(sdk), beforeHash);
    assert.equals(list(), beforeFiles);
    assert.equals(sha256Tree(pkgRoot), compiledBefore);
    assert.equals(
      fs.readdirSync(pkgRoot, { recursive: true }).length,
      compiledFiles,
    );
  });

  it("should keep secrets out of the workspace and the sdk binding", async function () {
    const p = await defaultPrepared();
    const api = await startMockApi();
    try {
      const svc = await service(p, configFor(api));
      const res = await svc.execute(
        { code: "return (await sdk.PetsApi.listPets({ limit: 1 })).length;" },
        LOCAL,
      );
      assert.isTrue(res.ok, JSON.stringify(res.error));
    } finally {
      await api.close();
    }
    const all = fs
      .readdirSync(p.workspaceDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"))
      .join("\n");
    for (const v of Object.values(SECRET_ENV)) {
      refute.contains(all, v);
    }
  });
});

describe("prepare - actionable errors", function () {
  it("should reject missing and invalid inputs", async function () {
    const dir = workDir("invalid");
    await expectPrepareError(
      { spec: path.join(dir, "missing.yaml"), sdk: SDK_726 },
      "SPEC_NOT_FOUND",
    );
    const bad = path.join(dir, "bad.yaml");
    fs.writeFileSync(bad, "openapi: 3.0.3\ninfo: {}\npaths: 7\n");
    await expectPrepareError({ spec: bad, sdk: SDK_726 }, "SPEC_INVALID");
    const err = await expectPrepareError(
      { spec: SPEC, sdk: path.join(dir, "no-sdk") },
      "SDK_NOT_FOUND",
    );
    assert.match(err.hint!, /typescript-fetch SDK/);
    const zip = path.join(dir, "sdk.zip");
    fs.writeFileSync(zip, "x");
    await expectPrepareError({ spec: SPEC, sdk: zip }, "SDK_INPUT_UNSUPPORTED");
  });

  it("should explain missing SDK dependencies without installing anything", async function () {
    const sdk = sdkCopy("deps");
    const pkgFile = path.join(sdk, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.dependencies = { "oag-mcp-test-missing-dep": "1.0.0" };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const before = sha256Tree(sdk);
    const err = await expectPrepareError(
      { spec: SPEC, sdk },
      "SDK_DEPENDENCIES_MISSING",
    );
    assert.match(err.message, /oag-mcp-test-missing-dep/);
    assert.match(err.hint!, /npm install --omit=dev --ignore-scripts/);
    assert.match(err.hint!, /never installs packages/);
    refute(fs.existsSync(path.join(sdk, "node_modules")));
    assert.equals(sha256Tree(sdk), before);
  });

  it("should reject SDKs from other generators and unsupported options", async function () {
    const axios = sdkCopy("axios");
    fs.writeFileSync(
      path.join(axios, "src", "runtime.ts"),
      'import globalAxios from "axios";\nexport const BASE_PATH = "x";\n',
    );
    const err = await expectPrepareError(
      { spec: SPEC, sdk: axios },
      "SDK_GENERATOR_UNSUPPORTED",
    );
    assert.match(err.message, /typescript-axios/);
    const records = fileLogs("compat");
    try {
      await prepareSdk({ spec: SPEC, sdk: axios, logs: records.logs });
    } catch {
      // expected
    }
    assert(records.records().some((r) => r.event === "prepare.compat.failed"));
    const noVersion = sdkCopy("noversion");
    fs.rmSync(path.join(noVersion, ".openapi-generator"), {
      recursive: true,
      force: true,
    });
    await expectPrepareError(
      { spec: SPEC, sdk: noVersion },
      "SDK_OAG_VERSION_UNKNOWN",
    );
    await expectPrepareError(
      { spec: SPEC, sdk: SDK_726, sdkLayout: "compiled" },
      "SDK_LAYOUT_UNSUPPORTED",
    );
  });

  it("should reject a spec that does not match the SDK", async function () {
    const dir = workDir("mismatch");
    const spec = path.join(dir, "openapi.yaml");
    fs.writeFileSync(
      spec,
      fs
        .readFileSync(SPEC, "utf8")
        .replace("/store/inventory:", "/store/stock:"),
    );
    const err = await expectPrepareError(
      { spec, sdk: SDK_726 },
      "SDK_SPEC_MISMATCH",
    );
    assert.match(err.message, /getStoreInventory/);
  });
});

describe("serve - start-up preparation and lifecycle", function () {
  it("should prepare once and reuse the index and bindings for every session and call", async function () {
    this.timeout(60000);
    const root = workDir("ws-once");
    const api = await startMockApi();
    const { logs, records } = fileLogs("once");
    const running = await serve({
      spec: SPEC,
      sdk: SDK_726,
      workspaceRoot: root,
      transport: "streamable-http",
      config: configFor(api, { http: { port: 0 } }),
      configBaseDir: process.cwd(),
      logs,
    });
    try {
      const [ws] = workspaces(root);
      assert.isString(ws);
      const bundle = path.join(root, ws, "sdk", "sdk.bundle.js");
      const mtime = fs.statSync(bundle).mtimeMs;
      for (let i = 0; i < 3; i++) {
        const client = new Client({ name: `c${i}`, version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(running.url!)),
        );
        const tools = await client.listTools();
        assert.equals(tools.tools.map((t) => t.name).sort(), [
          "execute",
          "search",
        ]);
        const s = await client.callTool({
          name: "search",
          arguments: { query: "visits" },
        });
        assert.equals(
          (s.structuredContent as { results: Array<{ id: string }> }).results[0]
            .id,
          "PetsApi.listPetVisits",
        );
        const e = await client.callTool({
          name: "execute",
          arguments: {
            code: "return (await sdk.PetsApi.listPets({ limit: 2 })).map((p) => p.name);",
          },
        });
        assert.equals((e.structuredContent as { result: unknown }).result, [
          "Biscuit",
          "Mochi",
        ]);
        await client.close();
      }
      assert.equals(fs.statSync(bundle).mtimeMs, mtime);
      assert.equals(workspaces(root), [ws]);
    } finally {
      await running.close();
      await api.close();
    }
    const events = records().map((r) => r.event);
    const count = (e: string) => events.filter((x) => x === e).length;
    for (const once of [
      "prepare.started",
      "prepare.spec.loaded",
      "prepare.sdk.bundled",
      "prepare.index.created",
      "executor.verified",
      "tools.registered",
      "server.ready",
    ]) {
      assert.equals(count(once), 1, once);
    }
    assert.equals(count("execution.completed"), 3);
    const stages = records()
      .filter((r) => r.event === "prepare.stage.completed")
      .map((r) => r.stage);
    assert.equals(stages, [
      "inputs",
      "compatibility",
      "sdk",
      "index",
      "executor",
    ]);
    assert.equals(
      typeof records().find((r) => r.event === "server.ready")!
        .startupDurationMs,
      "number",
    );
    // Normal shutdown removes the workspace.
    assert.equals(workspaces(root), []);
    assert(events.includes("prepare.workspace.cleaned"));
  });

  it("should not start and should remove the workspace when a later stage fails", async function () {
    const root = workDir("ws-late-fail");
    const { logs, records } = fileLogs("late");
    // An unsupported sandbox runtime: the executor (stage 5) cannot start.
    const fakeDeno = path.join(workDir("fake-deno"), "deno");
    fs.writeFileSync(fakeDeno, "#!/bin/sh\necho 'deno 1.0.0'\n", {
      mode: 0o755,
    });
    const api = await startMockApi();
    try {
      await serve({
        spec: SPEC,
        sdk: SDK_726,
        workspaceRoot: root,
        transport: "streamable-http",
        config: configFor(api, {
          http: { port: 0 },
          execution: { denoPath: fakeDeno },
        }),
        configBaseDir: process.cwd(),
        logs,
      });
      assert(false, "serve should fail");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "DENO_VERSION_UNSUPPORTED");
    } finally {
      await api.close();
    }
    assert.equals(workspaces(root), []);
    const failed = records().find((r) => r.event === "prepare.stage.failed");
    assert.equals(failed?.stage, "executor");
    refute(records().some((r) => r.event === "server.ready"));
  });

  it("should sweep workspaces left behind by processes that no longer exist", async function () {
    const root = workDir("ws-stale");
    const stale = path.join(root, `${WORKSPACE_PREFIX}stale`);
    fs.mkdirSync(stale);
    fs.writeFileSync(
      path.join(stale, ".oag-mcp-owner.json"),
      JSON.stringify({ pid: 2 ** 22 + 12345, hostname: os.hostname() }),
    );
    const foreign = path.join(root, `${WORKSPACE_PREFIX}foreign`);
    fs.mkdirSync(foreign);
    const p = await prepareSdk({
      spec: SPEC,
      sdk: SDK_726,
      workspaceRoot: root,
      logs: fileLogs().logs,
    });
    refute(fs.existsSync(stale));
    assert(fs.existsSync(foreign), "directories without an owner are kept");
    assert.isTrue(p.cleanup());
    assert.equals(workspaces(root), [path.basename(foreign)]);
  });
});

describe("serve - CLI processes", function () {
  it("should keep stdio stdout protocol-only during preparation and clean up when the client disconnects", async function () {
    this.timeout(60000);
    const root = workDir("cli-stdio-tmp");
    const api = await startMockApi();
    const config = writeConfig(workDir("cli-stdio"), {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(),
    });
    try {
      const child = spawn(
        process.execPath,
        [
          BIN,
          "serve",
          "--spec",
          SPEC,
          "--sdk",
          SDK_TGZ,
          "--transport",
          "stdio",
          "--config",
          config,
          "--log-level",
          "debug",
          "--log-format",
          "pretty",
        ],
        {
          env: { ...process.env, ...SECRET_ENV, TMPDIR: root },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      // Sent immediately: requests wait in the pipe until preparation ends.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "1" },
          },
        })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no tools/list response: ${stderr}`)),
          45000,
        );
        child.stdout.on("data", () => {
          if (/"id":2/.test(stdout)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      assert.equals(workspaces(root).length, 1);
      child.stdin.end();
      const code = await new Promise((r) => child.on("close", r));
      assert.equals(code, 0, stderr);
      const lines = stdout.split("\n").filter(Boolean);
      for (const l of lines) {
        assert.equals(JSON.parse(l).jsonrpc, "2.0", l);
      }
      const list = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
      assert.equals(
        list.result.tools.map((t: { name: string }) => t.name).sort(),
        ["execute", "search"],
      );
      // Preparation was logged, to stderr only.
      assert.match(stderr, /prepare\.stage\.completed/);
      assert.match(stderr, /server\.ready/);
      assert.match(stderr, /stdin_closed/);
      assert.equals(workspaces(root), []);
    } finally {
      await api.close();
    }
  });

  it("should remove the workspace on SIGTERM while serving or starting, and on start-up failure", async function () {
    this.timeout(60000);
    const root = workDir("cli-http-tmp");
    const api = await startMockApi();
    const config = writeConfig(workDir("cli-http"), {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(),
    });
    try {
      const server = await startHttpServer(
        ["--spec", SPEC, "--sdk", SDK_726, "--config", config],
        { ...SECRET_ENV, TMPDIR: root },
      );
      assert.equals(workspaces(root).length, 1);
      await server.stop();
      assert.equals(workspaces(root), [], server.stderr());
    } finally {
      await api.close();
    }
    // A signal during preparation also removes the workspace.
    const early = spawn(
      process.execPath,
      [BIN, "serve", "--spec", SPEC, "--sdk", SDK_726, "--log-level", "info"],
      {
        env: { ...process.env, TMPDIR: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let earlyErr = "";
    early.stderr.on("data", (d) => {
      earlyErr += d;
      if (/prepare\.stage\.completed/.test(earlyErr) && !early.killed) {
        early.kill("SIGTERM");
      }
    });
    const earlyCode = await new Promise((r) => early.on("close", r));
    assert.equals(earlyCode, 1, earlyErr);
    assert.match(earlyErr, /"phase":"starting"/);
    assert.match(earlyErr, /STARTUP_ABORTED/);
    refute.match(earlyErr, /server\.ready/);
    assert.equals(workspaces(root), [], earlyErr);
    const sdk = sdkCopy("cli-deps");
    const pkgFile = path.join(sdk, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.dependencies = { "oag-mcp-test-missing-dep": "1.0.0" };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const child = spawn(
      process.execPath,
      [BIN, "serve", "--spec", SPEC, "--sdk", sdk, "--log-level", "silent"],
      {
        env: { ...process.env, TMPDIR: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((r) => child.on("close", r));
    assert.equals(code, 1);
    assert.equals(stdout, "");
    assert.match(stderr, /SDK_DEPENDENCIES_MISSING/);
    assert.match(stderr, /npm install --omit=dev --ignore-scripts/);
    assert.equals(workspaces(root), []);
  });
});
