"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import referee from "@sinonjs/referee";
import sinon from "sinon";

import {
  WORKSPACE_PREFIX,
  bindingDeclaration,
  createWorkspace,
  sweepStaleWorkspaces,
} from "../../lib/prepare/workspace.js";
import type { MethodRecord } from "../../lib/types.js";
import { quietLogs } from "../helpers/fakes.js";
import { tmpDir } from "../helpers/paths.js";

const { assert, refute } = referee;

/** Write a workspace-like directory with an owner marker. */
function fakeWorkspace(
  root: string,
  name: string,
  owner?: Record<string, unknown>,
): string {
  const dir = path.join(root, `${WORKSPACE_PREFIX}${name}`);
  fs.mkdirSync(dir);
  if (owner) {
    fs.writeFileSync(
      path.join(dir, ".oag-mcp-owner.json"),
      JSON.stringify(owner),
    );
  }
  return dir;
}

describe("workspace - createWorkspace", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("should create a private directory and remove it on cleanup", function () {
    const root = tmpDir();
    const { logs } = quietLogs();
    const ws = createWorkspace({ root, logs });
    assert(path.basename(ws.dir).startsWith(WORKSPACE_PREFIX));
    assert.equals(fs.statSync(ws.dir).mode & 0o777, 0o700);
    assert.isTrue(ws.cleanup());
    refute(fs.existsSync(ws.dir));
    assert.isTrue(ws.cleanup(), "idempotent");
  });

  it("should log and report a cleanup failure instead of throwing", function () {
    const root = tmpDir();
    const { logs, records } = quietLogs();
    const ws = createWorkspace({ root, logs });
    sinon
      .stub(fs, "rmSync")
      .throws(Object.assign(new Error("busy"), { code: "EBUSY" }));
    assert.isFalse(ws.cleanup());
    sinon.restore();
    const failed = records().find(
      (r) => r.event === "prepare.workspace.cleanup_failed",
    );
    assert.equals(failed?.get("error"), "EBUSY");
    assert.isTrue(ws.cleanup());
  });
});

describe("workspace - sweepStaleWorkspaces", function () {
  it("should remove only workspaces of dead processes on this host", function () {
    const root = tmpDir();
    const { logs } = quietLogs();
    const dead = fakeWorkspace(root, "dead", {
      pid: 2 ** 22 + 4242,
      hostname: os.hostname(),
    });
    const alive = fakeWorkspace(root, "alive", {
      pid: process.pid,
      hostname: os.hostname(),
    });
    const otherHost = fakeWorkspace(root, "other", {
      pid: 2 ** 22 + 4242,
      hostname: `${os.hostname()}-elsewhere`,
    });
    const unmarked = fakeWorkspace(root, "unmarked");
    const unrelated = path.join(root, "something-else");
    fs.mkdirSync(unrelated);
    assert.equals(sweepStaleWorkspaces(root, logs), 1);
    refute(fs.existsSync(dead));
    for (const kept of [alive, otherHost, unmarked, unrelated]) {
      assert(fs.existsSync(kept), kept);
    }
  });

  it("should tolerate a missing root", function () {
    const { logs } = quietLogs();
    assert.equals(
      sweepStaleWorkspaces(path.join(tmpDir(), "missing"), logs),
      0,
    );
  });
});

describe("workspace - bindingDeclaration", function () {
  it("should declare only indexed methods per API class", function () {
    const decl = bindingDeclaration([
      { className: "PetsApi", methodName: "listPets" },
      { className: "PetsApi", methodName: "getPetById" },
      { className: "AdminApi", methodName: "deletePet" },
    ] as MethodRecord[]);
    assert.contains(
      decl,
      'readonly AdminApi: Pick<__sdk.AdminApi, "deletePet">;',
    );
    assert.contains(
      decl,
      'readonly PetsApi: Pick<__sdk.PetsApi, "getPetById" | "listPets">;',
    );
    assert(decl.indexOf("AdminApi") < decl.indexOf("PetsApi"));
  });
});
