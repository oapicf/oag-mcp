"use strict";
import { createRequire } from "node:module";
import path from "node:path";

import referee from "@sinonjs/referee";

import {
  denoPlatformPackage,
  resolveDeno,
} from "../../lib/executor/deno-executor.js";

const { assert } = referee;
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
