"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { OagMcpError } from "../../lib/errors.js";
import {
  type PrepareOptions,
  prepareSdk,
  runStage,
} from "../../lib/prepare/prepare.js";
import { WORKSPACE_PATHS } from "../../lib/prepare/workspace.js";
import { quietLogs } from "../helpers/fakes.js";
import {
  SDK_726,
  SDK_TGZ,
  SPEC,
  copyFixture,
  tmpDir,
} from "../helpers/paths.js";

const { assert, refute, match } = referee;

function options(extra: Partial<PrepareOptions> = {}) {
  const { logs, records } = quietLogs();
  const workspaceRoot = tmpDir();
  return {
    opts: { spec: SPEC, sdk: SDK_726, workspaceRoot, logs, ...extra },
    records,
    workspaceRoot,
  };
}

async function rejection(p: Promise<unknown>): Promise<OagMcpError> {
  try {
    await p;
  } catch (e) {
    return e as OagMcpError;
  }
  throw new Error("expected a rejection");
}

describe("prepare - runStage", function () {
  it("should log a stage's start and completion and return its result", async function () {
    const { opts, records } = options();
    assert.equals(await runStage(opts.logs, "index", () => 7), 7);
    const done = records().find((r) => r.event === "prepare.stage.completed")!;
    assert.equals(done.get("stage"), "index");
    assert.equals(done.outcome, "success");
  });

  it("should not start a stage once cancelled", async function () {
    const { opts, records } = options();
    const abort = new AbortController();
    abort.abort();
    let ran = false;
    await assert.rejects(
      runStage(opts.logs, "sdk", () => (ran = true), abort.signal),
      match({ code: "STARTUP_ABORTED" }),
    );
    refute(ran);
    assert.contains(
      records().map((r) => r.event),
      "prepare.aborted",
    );
  });

  it("should log a failed stage's error code, and compatibility failures separately", async function () {
    const { opts, records } = options();
    await assert.rejects(
      runStage(opts.logs, "compatibility", () => {
        throw new OagMcpError("SDK_X", "no");
      }),
    );
    await assert.rejects(
      runStage(opts.logs, "index", () => {
        throw new TypeError("bug");
      }),
    );
    const failed = records().filter((r) => r.event === "prepare.stage.failed");
    assert.equals(
      failed.map((r) => [r.get("stage"), r.get("errorCode")]),
      [
        ["compatibility", "SDK_X"],
        ["index", "UNEXPECTED"],
      ],
    );
    assert.equals(
      records().filter((r) => r.event === "prepare.compat.failed").length,
      1,
    );
  });
});

describe("prepare - prepareSdk", function () {
  this.timeout(60000);

  it("should prepare a source SDK into a private workspace", async function () {
    const { opts, records } = options();
    const prepared = await prepareSdk(opts);
    try {
      const ws = prepared.workspaceDir;
      for (const p of [
        WORKSPACE_PATHS.bundle,
        WORKSPACE_PATHS.runner,
        WORKSPACE_PATHS.binding,
        path.join(WORKSPACE_PATHS.types, "index.d.ts"),
        path.join(WORKSPACE_PATHS.tsLib, "lib.es2022.d.ts"),
      ]) {
        assert(fs.existsSync(path.join(ws, p)), p);
      }
      const { info } = prepared;
      assert.equals(info.target.sdkLayout, "source");
      assert.equals(info.target.oagVersion, "7.26.0");
      assert.equals(info.target.sdkPackage!.name, "petclinic-sdk");
      assert.equals(info.inputs.spec.fileName, "openapi.yaml");
      assert.match(info.inputs.spec.sha256, /^[0-9a-f]{64}$/);
      assert.equals(info.inputs.sdk.kind, "directory");
      assert.isString(info.api.title);
      assert.equals(prepared.records.length, prepared.bindings.length);
      assert.equals(info.operations, prepared.bindings);
      assert.greater(prepared.records.length, 0);
      for (const u of info.unmappedOperations) {
        assert.contains(prepared.warnings.join("\n"), `Operation ${u.key}`);
      }
      const events = records().map((r) => r.event);
      for (const e of [
        "prepare.started",
        "prepare.spec.loaded",
        "prepare.sdk.resolved",
        "prepare.compat.checked",
        "prepare.sdk.bundled",
        "prepare.index.created",
        "prepare.sdk.prepared",
      ]) {
        assert.contains(events, e);
      }
    } finally {
      assert.isTrue(prepared.cleanup());
    }
    refute(fs.existsSync(prepared.workspaceDir));
  });

  it("should prepare a packed SDK from its compiled declarations", async function () {
    const { opts } = options({ sdk: SDK_TGZ, sdkLayout: "compiled" });
    const prepared = await prepareSdk(opts);
    try {
      assert.equals(prepared.info.inputs.sdk.kind, "archive");
      assert.equals(prepared.info.target.sdkLayout, "compiled");
      assert(
        fs.existsSync(
          path.join(prepared.workspaceDir, WORKSPACE_PATHS.types, "index.d.ts"),
        ),
      );
    } finally {
      prepared.cleanup();
    }
  });

  it("should warn about type errors in the SDK and operations it lacks", async function () {
    const sdk = copyFixture(SDK_726);
    fs.appendFileSync(
      path.join(sdk, "src", "index.ts"),
      '\nexport const broken: number = "not a number";\n',
    );
    fs.rmSync(path.join(sdk, "package.json"));
    const spec = path.join(tmpDir(), "openapi.yaml");
    fs.writeFileSync(
      spec,
      fs
        .readFileSync(SPEC, "utf8")
        .replace(
          /^paths:\n/m,
          "paths:\n  /extra:\n    get:\n      operationId: getExtra\n      responses:\n        '200':\n          description: ok\n",
        ),
    );
    const { opts, records } = options({ sdk, spec });
    const prepared = await prepareSdk(opts);
    prepared.cleanup();
    assert.isUndefined(prepared.info.target.sdkPackage);
    const warnings = prepared.warnings.join("\n");
    assert.match(warnings, /SDK has no package\.json/);
    assert.match(
      warnings,
      /SDK declarations emitted with 1 TypeScript diagnostic\(s\): Type 'string' is not assignable/,
    );
    assert.match(
      warnings,
      /Operation GET \/extra \(getExtra\) has no SDK method/,
    );
    assert.greater(
      records().filter((r) => r.event === "prepare.warning").length,
      1,
    );
  });

  it("should require a spec and an SDK, and an existing spec file", async function () {
    for (const [extra, code] of [
      [{ spec: "" }, "CLI_ARGS_INVALID"],
      [{ sdk: "" }, "CLI_ARGS_INVALID"],
      [{ spec: path.join(tmpDir(), "none.yaml") }, "SPEC_NOT_FOUND"],
      [{ spec: tmpDir() }, "SPEC_NOT_FOUND"],
    ] as const) {
      const { opts, workspaceRoot, records } = options(extra);
      const err = await rejection(prepareSdk(opts));
      assert.equals(err.code, code);
      assert.equals(fs.readdirSync(workspaceRoot), [], "workspace removed");
      assert.equals(
        records()
          .find((r) => r.event === "prepare.failed")!
          .get("errorCode"),
        code,
      );
    }
  });

  it("should explain how to install missing SDK dependencies", async function () {
    const sdk = copyFixture(SDK_726);
    const pkgFile = path.join(sdk, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.dependencies = { "not-installed-pkg": "1.0.0" };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const err = await rejection(prepareSdk(options({ sdk }).opts));
    assert.equals(err.code, "SDK_DEPENDENCIES_MISSING");
    assert.match(err.message, /not-installed-pkg/);
    assert.match(
      err.hint!,
      /Run `npm install --omit=dev --ignore-scripts` in /,
    );
    assert.equals(err.details!.missing, ["not-installed-pkg"]);
  });

  it("should tell archive users to extract and install before serving", async function () {
    const work = tmpDir();
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["-xzf", SDK_TGZ, "-C", work]);
    const pkgFile = path.join(work, "package", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.dependencies = { "not-installed-pkg": "1.0.0" };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const archive = path.join(work, "sdk.tgz");
    execFileSync("tar", ["-czf", archive, "-C", work, "package"]);
    const err = await rejection(prepareSdk(options({ sdk: archive }).opts));
    assert.equals(err.code, "SDK_DEPENDENCIES_MISSING");
    assert.match(err.hint!, /Extract the archive/);
  });
});
