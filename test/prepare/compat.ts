"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { inspectSdk } from "../../lib/prepare/compat.js";
import { extractArchive } from "../../lib/prepare/sdk-input.js";
import { SUPPORTED_OAG_VERSIONS } from "../../lib/version.js";
import { OagMcpError } from "../../lib/errors.js";
import {
  SDK_726,
  SDK_TGZ,
  SDK_VARIANT,
  copyFixture,
  tmpDir,
} from "../helpers/paths.js";

const { assert } = referee;

function expectCode(fn: () => unknown, code: string): OagMcpError {
  try {
    fn();
  } catch (e) {
    assert(e instanceof OagMcpError, String(e));
    assert.equals((e as OagMcpError).code, code);
    return e as OagMcpError;
  }
  throw new Error(`expected ${code}`);
}

describe("compat - inspectSdk", function () {
  it("should detect the source layout and version of the 7.26.0 fixture", function () {
    const insp = inspectSdk(SDK_726);
    assert.equals(insp.layout, "source");
    assert.equals(insp.oagVersion, "7.26.0");
    assert.isTrue(insp.oagVersionTested);
    assert.equals(path.basename(insp.entry), "index.ts");
    assert.equals(
      insp.apiFiles.map((f) => path.basename(f)),
      ["AdminApi.ts", "OwnersApi.ts", "PetsApi.ts", "StoreApi.ts"],
    );
    assert.equals(insp.pkg?.name, "petclinic-sdk");
  });

  it("should accept every version in SUPPORTED_OAG_VERSIONS as tested", function () {
    for (const v of SUPPORTED_OAG_VERSIONS) {
      const dir = copyFixture(SDK_726);
      fs.writeFileSync(
        path.join(dir, ".openapi-generator", "VERSION"),
        `${v}\n`,
      );
      const insp = inspectSdk(dir);
      assert.equals(insp.oagVersion, v);
      assert.isTrue(insp.oagVersionTested);
    }
  });

  it("should detect generator options from the variant fixture", function () {
    const insp = inspectSdk(SDK_VARIANT);
    assert.isTrue(insp.detectedOptions.withInterfaces as boolean);
    assert.isTrue(insp.detectedOptions.withoutRuntimeChecks as boolean);
    assert.equals(insp.detectedOptions.importFileExtension, ".js");
    assert.equals(insp.detectedOptions.fileNaming, "kebab-case");
  });

  it("should use the compiled layout of a packed SDK when requested", async function () {
    const root = await extractArchive(SDK_TGZ, path.join(tmpDir(), "x"));
    const insp = inspectSdk(root, { layout: "compiled" });
    assert.equals(insp.layout, "compiled");
    assert.match(insp.entry, /dist[\\/]esm[\\/]index\.js$/);
    assert.match(insp.typesDir!, /dist$/);
  });

  it("should reject an SDK without a recorded generator version unless declared", function () {
    const dir = copyFixture(SDK_726);
    fs.rmSync(path.join(dir, ".openapi-generator"), { recursive: true });
    expectCode(() => inspectSdk(dir), "SDK_OAG_VERSION_UNKNOWN");
    assert.equals(
      inspectSdk(dir, { declaredOagVersion: "7.26.0" }).oagVersion,
      "7.26.0",
    );
  });

  it("should reject untested generator versions unless explicitly allowed", function () {
    const dir = copyFixture(SDK_726);
    fs.writeFileSync(
      path.join(dir, ".openapi-generator", "VERSION"),
      "7.10.0\n",
    );
    const err = expectCode(
      () => inspectSdk(dir),
      "SDK_OAG_VERSION_UNSUPPORTED",
    );
    assert.match(err.hint, /--allow-untested-oag-version/);
    const ok = inspectSdk(dir, { allowUntestedOagVersion: true });
    assert.isFalse(ok.oagVersionTested);
    assert.equals(ok.warnings.length, 1);
  });

  it("should reject sagasAndRecords output", function () {
    const dir = copyFixture(SDK_726);
    fs.writeFileSync(
      path.join(dir, "src", "apis", "allSagas.ts"),
      "export {};\n",
    );
    expectCode(() => inspectSdk(dir), "SDK_OPTION_UNSUPPORTED");
  });

  it("should reject stringEnums output", function () {
    const dir = copyFixture(SDK_726);
    fs.appendFileSync(
      path.join(dir, "src", "models", "Species.ts"),
      "\nexport enum Legacy { A = 'a' }\n",
    );
    expectCode(() => inspectSdk(dir), "SDK_OPTION_UNSUPPORTED");
  });

  it("should name other generators when their output is supplied", function () {
    const dir = copyFixture(SDK_726);
    fs.appendFileSync(
      path.join(dir, "src", "runtime.ts"),
      "\nimport globalAxios from 'axios';\n",
    );
    const err = expectCode(() => inspectSdk(dir), "SDK_GENERATOR_UNSUPPORTED");
    assert.match(err.message, /typescript-axios/);
  });

  it("should reject unrecognised layouts with a pointer to the docs", function () {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    const err = expectCode(() => inspectSdk(dir), "SDK_LAYOUT_UNSUPPORTED");
    assert.match(err.hint, /sdk-compatibility/);
  });

  it("should reject an SDK without API classes", function () {
    const dir = copyFixture(SDK_726);
    for (const f of fs.readdirSync(path.join(dir, "src", "apis"))) {
      if (f !== "index.ts") fs.rmSync(path.join(dir, "src", "apis", f));
    }
    expectCode(() => inspectSdk(dir), "SDK_LAYOUT_UNSUPPORTED");
  });
});
