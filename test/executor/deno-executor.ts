"use strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import referee from "@sinonjs/referee";
import sinon from "sinon";

import {
  DenoExecutor,
  denoPlatformPackage,
  resolveDeno,
  sandboxEnv,
} from "../../lib/executor/deno-executor.js";
import type {
  BridgeHandler,
  ExecutionLimits,
} from "../../lib/executor/types.js";
import { OagMcpError } from "../../lib/errors.js";
import { quietLogs } from "../helpers/fakes.js";
import { tmpDir } from "../helpers/paths.js";

const { assert, match } = referee;
const require = createRequire(import.meta.url);

describe("deno-executor - denoPlatformPackage", function () {
  it("should name the platform package the way the deno npm package does", function () {
    assert.equals(denoPlatformPackage("darwin", "arm64"), "@deno/darwin-arm64");
    assert.equals(denoPlatformPackage("darwin", "x64"), "@deno/darwin-x64");
    assert.equals(
      denoPlatformPackage("linux", "arm64"),
      "@deno/linux-arm64-glibc",
    );
    assert.equals(denoPlatformPackage("linux", "x64"), "@deno/linux-x64-glibc");
    assert.equals(denoPlatformPackage("win32", "x64"), "@deno/win32-x64");
  });

  it("should only name packages the deno npm package actually provides", function () {
    const optional = Object.keys(
      require("deno/package.json").optionalDependencies,
    );
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "arm64"],
      ["win32", "x64"],
    ]) {
      assert.contains(optional, denoPlatformPackage(platform, arch));
    }
  });
});

describe("deno-executor - resolveDeno", function () {
  let saved: string | undefined;

  beforeEach(function () {
    saved = process.env.OAG_MCP_DENO_PATH;
    delete process.env.OAG_MCP_DENO_PATH;
  });

  afterEach(function () {
    if (saved === undefined) {
      delete process.env.OAG_MCP_DENO_PATH;
    } else {
      process.env.OAG_MCP_DENO_PATH = saved;
    }
  });

  it("should prefer this platform's binary package over the deno package's own copy, which may be for another OS", function () {
    const runtime = resolveDeno();
    assert.equals(runtime.source, "npm-package");
    const platformDir = path.dirname(
      require.resolve(`${denoPlatformPackage()}/package.json`),
    );
    assert.equals(path.dirname(runtime.path), platformDir);
    assert.match(runtime.version, /^2\.\d+\.\d+$/);
  });

  it("should use a configured path before the npm package", function () {
    const fromPackage = resolveDeno();
    const runtime = resolveDeno(fromPackage.path);
    assert.equals(runtime.source, "configured");
    assert.equals(runtime.path, fromPackage.path);
  });
});

describe("deno-executor - resolveDeno candidates", function () {
  let saved: string | undefined;

  beforeEach(function () {
    saved = process.env.OAG_MCP_DENO_PATH;
    delete process.env.OAG_MCP_DENO_PATH;
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) {
      delete process.env.OAG_MCP_DENO_PATH;
    } else {
      process.env.OAG_MCP_DENO_PATH = saved;
    }
  });

  it("should use OAG_MCP_DENO_PATH before the npm package", function () {
    process.env.OAG_MCP_DENO_PATH = resolveDeno().path;
    assert.equals(resolveDeno().source, "env");
  });

  it("should skip candidates that are missing, fail or are not Deno", function () {
    const dir = tmpDir();
    const fails = script(dir, "fails", "exit 3");
    const notDeno = script(dir, "not-deno", 'echo "node v22.0.0"');
    for (const configured of [path.join(dir, "missing"), fails, notDeno]) {
      assert.equals(resolveDeno(configured).source, "npm-package", configured);
    }
  });

  it("should refuse a Deno outside the supported version range", function () {
    const old = script(tmpDir(), "deno", 'echo "deno 1.46.3 (stable)"');
    assert.exception(
      () => resolveDeno(old),
      match({ code: "DENO_VERSION_UNSUPPORTED" }),
    );
  });

  it("should fall back to the deno package's own copy without a platform package", function () {
    sinon.stub(process, "platform").value("freebsd");
    const runtime = resolveDeno();
    assert.equals(runtime.source, "npm-package");
    assert.equals(
      runtime.path,
      path.join(path.dirname(require.resolve("deno/package.json")), "deno"),
    );
  });

  it("should report that no Deno was found when no candidate runs", function () {
    sinon.stub(fs, "existsSync").returns(false);
    assert.exception(() => resolveDeno(), match({ code: "DENO_NOT_FOUND" }));
  });

  it("should find Deno on PATH and use it by absolute path", function () {
    const dir = tmpDir();
    const deno = script(dir, "deno", 'echo "deno 2.9.9 (stable)"');
    sinon.stub(process.env, "PATH").value(`${dir}${path.delimiter}/usr/bin`);
    // Only the PATH candidate exists: no configured path, no npm package.
    const existsSync = fs.existsSync;
    sinon
      .stub(fs, "existsSync")
      .callsFake((p) => String(p).startsWith(dir) && existsSync(p));
    const runtime = resolveDeno();
    assert.equals(runtime, { path: deno, version: "2.9.9", source: "path" });
    assert(path.isAbsolute(runtime.path), "spawnable without a PATH");
  });
});

describe("deno-executor - sandboxEnv", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("should give the sandbox only Deno bookkeeping in its own directory", function () {
    assert.equals(sandboxEnv("/t"), {
      DENO_DIR: path.join("/t", "deno-dir"),
      DENO_NO_UPDATE_CHECK: "1",
      DENO_NO_PROMPT: "1",
      NO_COLOR: "1",
      TMPDIR: "/t",
      HOME: "/t",
      TZ: "UTC",
    });
  });

  it("should pass SystemRoot through on Windows", function () {
    sinon.stub(process, "platform").value("win32");
    sinon.stub(process, "env").value({ SystemRoot: "C:\\Windows", X: "1" });
    const env = sandboxEnv("/t");
    assert.equals(env.SystemRoot, "C:\\Windows");
    assert.isUndefined(env.X);
  });
});

// A scripted runner speaking the executor protocol on stdin/stdout.
const RUNNER_PRELUDE = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const send = (m) => Deno.stdout.writeSync(encoder.encode(JSON.stringify(m) + "\\n"));
const raw = (t) => Deno.stdout.writeSync(encoder.encode(t));
const lines = (async function* () {
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      yield JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
})();
const next = async () => (await lines.next()).value;
const hang = () => new Promise(() => setInterval(() => {}, 1000));
const init = await next();
`;

const LIMITS: ExecutionLimits = {
  timeoutMs: 10000,
  memoryMb: 64,
  maxSdkCalls: 5,
  maxResultBytes: 4096,
  maxLogBytes: 1024,
  maxLogEntries: 10,
  maxStdoutBytes: 1024 * 1024,
};

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function executor(runner: string, denoPath?: string) {
  const workspaceDir = tmpDir();
  fs.mkdirSync(path.join(workspaceDir, "executor"));
  fs.writeFileSync(
    path.join(workspaceDir, "executor", "runner.js"),
    RUNNER_PRELUDE + runner,
  );
  const { logs, records } = quietLogs();
  const deno = resolveDeno();
  const ex = new DenoExecutor({
    workspaceDir,
    deno: denoPath ? { ...deno, path: denoPath } : deno,
    logs,
  });
  return { ex, records };
}

function run(
  ex: DenoExecutor,
  limits: Partial<ExecutionLimits> = {},
  bridge: BridgeHandler = async () => ({
    ok: false,
    error: { type: "permission_denied", message: "no" },
  }),
) {
  return ex.execute({
    executionId: "e1",
    moduleBase64: "Y29kZQ==",
    bindings: [
      {
        id: "PetsApi.listPets",
        className: "PetsApi",
        methodName: "listPets",
        httpMethod: "GET",
        path: "/pets",
        tags: [],
        security: [],
      },
    ],
    basePath: "http://api.test",
    limits: { ...LIMITS, ...limits },
    bridge,
  });
}

describe("deno-executor - DenoExecutor.execute", function () {
  this.timeout(30000);

  it("should send the init message and return the first done report", async function () {
    const { ex } = executor(`
raw("not json\\n");
send({ type: "unknown" });
send({ type: "done", ok: true, result: init, logs: [{ level: "log", message: "hi" }], logsTruncated: true });
send({ type: "done", ok: false, result: "second" });
`);
    const outcome = await run(ex);
    assert.isTrue(outcome.ok);
    assert.equals(outcome.result, {
      type: "init",
      code: "Y29kZQ==",
      verifyOnly: false,
      bindings: [
        {
          id: "PetsApi.listPets",
          className: "PetsApi",
          methodName: "listPets",
        },
      ],
      basePath: "http://api.test",
      limits: { maxLogBytes: 1024, maxLogEntries: 10, maxResultBytes: 4096 },
    });
    assert.isFalse(outcome.resultUndefined!);
    assert.equals(outcome.logs, [{ level: "log", message: "hi" }]);
    assert.isTrue(outcome.logsTruncated);
    assert.equals(outcome.stats.sdkCalls, 0);
    assert.isFalse(outcome.stats.terminated);
  });

  it("should default a done report's missing logs and flags", async function () {
    const { ex } = executor(
      `send({ type: "done", resultUndefined: 1, logs: "x" });`,
    );
    const outcome = await run(ex);
    assert.isFalse(outcome.ok);
    assert.isTrue(outcome.resultUndefined!);
    assert.equals(outcome.logs, []);
    assert.isFalse(outcome.logsTruncated);
  });

  it("should relay bridge fetches, report broker failures and cap SDK calls", async function () {
    const { ex, records } = executor(`
const replies = [];
for (const rid of [1, 2, 3]) {
  send({ type: "fetch", rid, binding: "PetsApi.listPets", url: "http://api.test/pets", method: "GET", headers: {}, body: null });
  replies.push(await next());
}
send({ type: "done", ok: true, result: replies });
`);
    let calls = 0;
    const outcome = await run(ex, { maxSdkCalls: 2 }, async (req, signal) => {
      calls++;
      assert.isFalse(signal.aborted);
      if (req.rid === 2) {
        throw new Error("broker down");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: [],
        body: "[]",
      };
    });
    assert.equals(calls, 2);
    const [first, second, third] = outcome.result as Array<
      Record<string, unknown>
    >;
    assert.equals(first, {
      type: "fetchResult",
      rid: 1,
      ok: true,
      status: 200,
      statusText: "OK",
      headers: [],
      body: "[]",
    });
    assert.equals(second.error, {
      type: "executor_error",
      message: "Broker failure: broker down",
    });
    assert.equals(
      (third.error as Record<string, unknown>).reason,
      "max_sdk_calls",
    );
    assert.equals(outcome.stats.sdkCalls, 3);
    const limit = records().find(
      (r) => r.event === "execution.resource_limit",
    )!;
    assert.equals(limit.get("limit"), "maxSdkCalls");
    // Audit records about the sandbox name its process.
    assert.isNumber((limit.raw.process as Record<string, unknown>).pid);
  });

  it("should kill a run that exceeds its time limit", async function () {
    const { ex, records } = executor(`await hang();`);
    const outcome = await run(ex, { timeoutMs: 300 });
    assert.equals(outcome.error!.type, "timeout");
    assert.match(outcome.error!.message, /300 ms time limit/);
    assert.isTrue(outcome.stats.terminated);
    const events = records().map((r) => r.event);
    assert.contains(events, "execution.timeout");
    assert.contains(events, "executor.terminated");
  });

  it("should kill a run that writes too much output", async function () {
    const { ex, records } = executor(`raw("x".repeat(4096)); await hang();`);
    const outcome = await run(ex, { maxStdoutBytes: 1024 });
    assert.equals(outcome.error, {
      type: "output_limit",
      reason: "stdout_limit",
      message: "Sandbox output exceeded 1024 bytes",
    });
    assert.isTrue(outcome.stats.terminated);
    assert.contains(
      records().map((r) => r.get("reason")),
      "output_limit",
    );
  });

  it("should report a sandbox that exits without reporting", async function () {
    const { ex } = executor(`Deno.exit(3);`);
    const outcome = await run(ex);
    assert.equals(outcome.error, {
      type: "executor_error",
      message: "Sandbox exited unexpectedly (code 3)",
    });
  });

  it("should recognise running out of memory from the sandbox's stderr", async function () {
    const { ex, records } = executor(`
Deno.stderr.writeSync(encoder.encode("Fatal JavaScript out of memory: Reached heap limit"));
Deno.exit(1);
`);
    const outcome = await run(ex, { memoryMb: 64 });
    assert.equals(outcome.error, {
      type: "resource_limit",
      reason: "memory_limit",
      message: "Execution exceeded the 64 MB memory limit",
    });
    assert.equals(
      records()
        .find((r) => r.event === "execution.resource_limit")!
        .get("limit"),
      "memoryMb",
    );
  });

  it("should recognise running out of memory after any amount of other stderr output", async function () {
    const { ex } = executor(`
for (let i = 0; i < 8; i++) {
  Deno.stderr.writeSync(encoder.encode("x".repeat(4096)));
}
await new Promise((r) => setTimeout(r, 50));
Deno.stderr.writeSync(encoder.encode("Fatal JavaScript out of memory: Reached heap limit"));
Deno.exit(1);
`);
    const outcome = await run(ex);
    assert.equals(outcome.error!.reason, "memory_limit");
  });

  it("should report other unexpected exits whatever the sandbox wrote to stderr", async function () {
    const { ex } = executor(`
for (let i = 0; i < 8; i++) {
  Deno.stderr.writeSync(encoder.encode("x".repeat(4096)));
}
Deno.exit(2);
`);
    const outcome = await run(ex);
    assert.equals(
      outcome.error!.message,
      "Sandbox exited unexpectedly (code 2)",
    );
  });

  it("should reap a runner that lingers after reporting, without a termination record", async function () {
    const { ex, records } = executor(
      `send({ type: "done", ok: true }); await hang();`,
    );
    const outcome = await run(ex);
    assert.isTrue(outcome.ok);
    await new Promise((r) => setTimeout(r, 800));
    assert.equals(
      records().filter((r) => r.event === "executor.terminated"),
      [],
    );
  });

  it("should keep the timeout outcome when a report arrives after the time limit", async function () {
    const { ex } = executor(`
send({ type: "fetch", rid: 1, binding: "x", url: "http://x", method: "GET", headers: {}, body: null });
await new Promise((r) => setTimeout(r, 50));
send({ type: "done", ok: true, result: "late" });
await hang();
`);
    const outcome = await run(ex, { timeoutMs: 200 }, () => {
      // Hold the host's event loop past the time limit while the runner's
      // report waits in the pipe: the timer runs before the report is read.
      const until = Date.now() + 600;
      while (Date.now() < until) {
        // busy
      }
      return Promise.resolve({
        ok: false,
        error: { type: "permission_denied", message: "no" },
      });
    });
    assert.equals(outcome.error!.type, "timeout");
    assert.isUndefined(outcome.result);
  });

  it("should survive a broker reply to a sandbox that has already exited", async function () {
    const { ex } = executor(`
send({ type: "fetch", rid: 1, binding: "x", url: "http://x", method: "GET", headers: {}, body: null });
Deno.exit(0);
`);
    const outcome = await run(ex, {}, () => {
      // Hold the host's event loop until the sandbox is gone, so the reply is
      // written to a closed pipe before its exit is noticed.
      const until = Date.now() + 500;
      while (Date.now() < until) {
        // busy
      }
      return Promise.resolve({
        ok: false,
        error: { type: "permission_denied", message: "no" },
      });
    });
    assert.equals(outcome.error, {
      type: "executor_error",
      message: "Sandbox exited unexpectedly (code 0)",
    });
  });

  it("should report a Deno binary that cannot be started", async function () {
    const { ex } = executor("", path.join(tmpDir(), "no-such-deno"));
    const outcome = await run(ex);
    assert.equals(outcome.error!.type, "executor_error");
    assert.match(outcome.error!.message, /^Failed to start Deno: .*ENOENT/);
  });

  it("should reject, after cleaning up, when the process cannot be spawned", async function () {
    const { ex } = executor("", "deno\0bad");
    await assert.rejects(run(ex), match({ code: "ERR_INVALID_ARG_VALUE" }));
  });
});

describe("deno-executor - DenoExecutor.verify", function () {
  this.timeout(30000);

  it("should load the bundle in verification mode without SDK calls", async function () {
    const { ex } = executor(`
send({ type: "fetch", rid: 1, binding: "x", url: "http://x", method: "GET", headers: {}, body: null });
const reply = await next();
send({ type: "done", ok: init.verifyOnly && init.code === "" && reply.error.reason === "max_sdk_calls" });
`);
    await ex.verify([], "http://api.test");
  });

  it("should fail when the bundle does not load", async function () {
    const { ex } = executor(
      `send({ type: "done", ok: false, error: { type: "runtime_error", message: "boom" } });`,
    );
    await assert.rejects(
      ex.verify([], "http://api.test"),
      match((e: OagMcpError) => {
        return (
          e.code === "EXECUTOR_VERIFY_FAILED" &&
          /failed to load in Deno: boom/.test(e.message)
        );
      }),
    );
  });
});
