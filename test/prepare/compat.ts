"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import ts from "typescript";

import { inspectSdk } from "../../lib/prepare/compat.js";
import { extractArchive } from "../../lib/prepare/sdk-input.js";
import { SUPPORTED_OAG_VERSIONS } from "../../lib/util/version.js";
import { OagMcpError } from "../../lib/errors.js";
import {
  SDK_726,
  SDK_TGZ,
  SDK_VARIANT,
  copyFixture,
  tmpDir,
} from "../helpers/paths.js";

const { assert, refute } = referee;

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

  it("should accept an SDK without package.json with a warning", function () {
    const dir = copyFixture(SDK_726);
    fs.rmSync(path.join(dir, "package.json"));
    const insp = inspectSdk(dir, { allowUntestedOagVersion: true });
    assert.isUndefined(insp.pkg);
    assert.match(insp.warnings[0], /no package\.json/);
  });

  it("should reject a package.json that is not valid JSON", function () {
    const dir = copyFixture(SDK_726);
    fs.writeFileSync(path.join(dir, "package.json"), "{nope");
    expectCode(() => inspectSdk(dir), "SDK_PACKAGE_INVALID");
  });

  it("should reject sagasAndRecords dependencies and record files", function () {
    const deps = copyFixture(SDK_726);
    const pkgFile = path.join(deps, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    pkg.dependencies = { ...pkg.dependencies, "redux-saga": "1.0.0" };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    const err = expectCode(() => inspectSdk(deps), "SDK_OPTION_UNSUPPORTED");
    assert.match(err.message, /sagasAndRecords/);

    const records = copyFixture(SDK_726);
    fs.writeFileSync(path.join(records, "src", "ApiEntitiesRecord.ts"), "");
    expectCode(() => inspectSdk(records), "SDK_OPTION_UNSUPPORTED");
  });

  it("should reject the Temporal date library", function () {
    const dir = copyFixture(SDK_726);
    fs.appendFileSync(
      path.join(dir, "src", "runtime.ts"),
      "\nconst now = Temporal.Now;\n",
    );
    const err = expectCode(() => inspectSdk(dir), "SDK_OPTION_UNSUPPORTED");
    assert.match(err.message, /dateLibrary=temporal/);
  });

  it("should reject a requested layout the SDK does not have", async function () {
    expectCode(
      () => inspectSdk(SDK_726, { layout: "compiled" }),
      "SDK_LAYOUT_UNSUPPORTED",
    );
    const dir = tmpDir();
    await extractArchive(SDK_TGZ, dir);
    const root = path.join(dir, "package");
    fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
    const err = expectCode(
      () => inspectSdk(root, { layout: "source" }),
      "SDK_LAYOUT_UNSUPPORTED",
    );
    assert.match(err.hint, /--sdk-layout compiled/);
  });

  it("should report the compiled entry point, declarations and package of a packed SDK", async function () {
    const dir = tmpDir();
    await extractArchive(SDK_TGZ, dir);
    const insp = inspectSdk(path.join(dir, "package"), { layout: "compiled" });
    assert.match(insp.entry, /dist[/\\]esm[/\\]index\.js$/);
    assert.match(insp.typesDir!, /dist$/);
    assert.equals(insp.pkg?.name, "petclinic-sdk");
    assert.isFalse(insp.apiFiles.some((f) => f.endsWith(".ts")));
  });
});

describe("compat - inspectSdk edge cases", function () {
  const src = (dir: string, ...p: string[]) => path.join(dir, "src", ...p);

  it("should reject an SDK whose runtime module cannot be read", function () {
    const dir = copyFixture(SDK_726);
    fs.rmSync(src(dir, "runtime.ts"));
    fs.mkdirSync(src(dir, "runtime.ts"));
    const err = expectCode(() => inspectSdk(dir), "SDK_LAYOUT_UNSUPPORTED");
    assert.match(err.message, /runtime module not found/);
  });

  it("should reject a runtime without the typescript-fetch markers", function () {
    const dir = copyFixture(SDK_726);
    const file = src(dir, "runtime.ts");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replaceAll("ResponseError", "Failure"),
    );
    const err = expectCode(() => inspectSdk(dir), "SDK_GENERATOR_UNSUPPORTED");
    assert.match(
      err.message,
      /missing typescript-fetch markers: ResponseError/,
    );
  });

  it("should reject an SDK without an apis directory", function () {
    const dir = copyFixture(SDK_726);
    fs.rmSync(src(dir, "apis"), { recursive: true });
    expectCode(() => inspectSdk(dir), "SDK_LAYOUT_UNSUPPORTED");
  });

  it("should inspect an SDK without models", function () {
    const dir = copyFixture(SDK_726);
    fs.rmSync(src(dir, "models"), { recursive: true });
    const insp = inspectSdk(dir);
    assert.equals(insp.apiFiles.length, 4);
    assert.isFalse(insp.detectedOptions.withoutRuntimeChecks as boolean);
  });

  it("should detect camelCase file naming", function () {
    const dir = copyFixture(SDK_726);
    for (const f of ["AdminApi", "OwnersApi", "PetsApi", "StoreApi"]) {
      const lower = f[0].toLowerCase() + f.slice(1);
      fs.renameSync(
        src(dir, "apis", `${f}.ts`),
        src(dir, "apis", `${lower}.ts`),
      );
    }
    assert.equals(inspectSdk(dir).detectedOptions.fileNaming, "camelCase");
  });

  it("should reject a declared generator version that contradicts the recorded one", function () {
    const err = expectCode(
      () => inspectSdk(SDK_726, { declaredOagVersion: "7.0.0" }),
      "SDK_OAG_VERSION_CONFLICT",
    );
    assert.match(err.message, /--sdk-oag-version 7\.0\.0 conflicts/);
    assert.equals(
      inspectSdk(SDK_726, { declaredOagVersion: "7.26.0" }).oagVersion,
      "7.26.0",
    );
  });
});

describe("compat - inspectSdk stringEnums in compiled SDKs", function () {
  this.timeout(60000);

  /**
   * A packed SDK whose Species model is a TypeScript enum, compiled the way
   * typescript-fetch's build does: CommonJS to dist/, ESM to dist/esm/.
   */
  async function compiledEnumSdk(esmDeclarations: boolean): Promise<string> {
    const root = await extractArchive(SDK_TGZ, path.join(tmpDir(), "x"));
    const model = path.join(root, "src", "models", "Species.ts");
    const text = fs.readFileSync(model, "utf8");
    const enumText = text.replace(
      /export const Species = \{[\s\S]*?\} as const;\nexport type Species = [^\n]*/,
      "export enum Species {\n    Dog = 'dog',\n    Cat = 'cat'\n}",
    );
    assert.match(enumText, /export enum Species/);
    fs.writeFileSync(model, enumText);
    for (const [module, out, declaration] of [
      [ts.ModuleKind.CommonJS, "dist", true],
      [ts.ModuleKind.ESNext, path.join("dist", "esm"), esmDeclarations],
    ] as const) {
      fs.rmSync(path.join(root, out, "models"), { recursive: true });
      ts.createProgram([path.join(root, "src", "index.ts")], {
        declaration,
        target: ts.ScriptTarget.ES2015,
        module,
        rootDir: path.join(root, "src"),
        outDir: path.join(root, out),
      }).emit();
    }
    // tsc's enum output, which no JavaScript pattern needs to recognise.
    assert.match(
      fs.readFileSync(
        path.join(root, "dist", "esm", "models", "Species.js"),
        "utf8",
      ),
      /export var Species;\n\(function \(Species\)/,
    );
    return root;
  }

  it("should reject a compiled stringEnums SDK", async function () {
    const root = await compiledEnumSdk(true);
    const err = expectCode(
      () => inspectSdk(root, { layout: "compiled" }),
      "SDK_OPTION_UNSUPPORTED",
    );
    assert.match(err.message, /stringEnums/);
  });

  it("should reject one whose ESM build has no declarations beside it", async function () {
    const root = await compiledEnumSdk(false);
    refute(
      fs.existsSync(path.join(root, "dist", "esm", "models", "Species.d.ts")),
    );
    expectCode(
      () => inspectSdk(root, { layout: "compiled" }),
      "SDK_OPTION_UNSUPPORTED",
    );
  });
});
