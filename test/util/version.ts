"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import semver from "semver";

import {
  DENO_VERSION_RANGE,
  SUPPORTED_OAG_VERSIONS,
  dependencyVersion,
  oagMcpName,
  oagMcpVersion,
  packageRoot,
} from "../../lib/util/version.js";
import { ROOT } from "../helpers/paths.js";

const { assert } = referee;

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

describe("version - oagMcpName", function () {
  it("should return the package name from package.json", function () {
    assert.equals(oagMcpName(), pkg.name);
  });
});

describe("version - oagMcpVersion", function () {
  it("should return the package version from package.json", function () {
    assert.equals(oagMcpVersion(), pkg.version);
  });
});

describe("version - packageRoot", function () {
  it("should locate the repository root from the util module", function () {
    assert.equals(packageRoot(), ROOT);
  });
});

describe("version - dependencyVersion", function () {
  it("should report installed versions and unknown for missing packages", function () {
    assert.equals(dependencyVersion("semver"), pkg.dependencies.semver);
    assert.equals(dependencyVersion("oag-mcp-no-such-package"), "unknown");
  });
});

describe("version - DENO_VERSION_RANGE", function () {
  it("should accept Deno 2.x from 2.5.0 and reject older, 3.x and pre-releases", function () {
    for (const ok of ["2.5.0", "2.9.6", "2.99.0"]) {
      assert.isTrue(semver.satisfies(ok, DENO_VERSION_RANGE), ok);
    }
    for (const bad of ["2.4.9", "3.0.0", "1.46.3", "2.9.6-rc.1"]) {
      assert.isFalse(semver.satisfies(bad, DENO_VERSION_RANGE), bad);
    }
    assert.isTrue(
      semver.satisfies(dependencyVersion("deno"), DENO_VERSION_RANGE),
      "the bundled deno dependency must be in range",
    );
  });
});

describe("version - SUPPORTED_OAG_VERSIONS", function () {
  it("should list exact, valid versions", function () {
    assert.equals(SUPPORTED_OAG_VERSIONS.length > 0, true);
    for (const v of SUPPORTED_OAG_VERSIONS) {
      assert.equals(semver.valid(v), v);
    }
  });
});
