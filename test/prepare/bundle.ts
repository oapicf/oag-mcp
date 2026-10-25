"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { OagMcpError } from "../../lib/errors.js";
import {
  AGENT_TS_LIBS,
  REQUIRED_RUNTIME_EXPORTS,
  bundleSdk,
  copyDeclarations,
  copyTsLibs,
  emitDeclarations,
  sdkCompilerOptions,
} from "../../lib/prepare/bundle.js";
import { SDK_726, tmpDir } from "../helpers/paths.js";

const { assert, refute } = referee;

/** Write files under a new directory. */
function files(entries: Record<string, string>): string {
  const dir = tmpDir();
  for (const [rel, text] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

async function bundle(root: string, entry: string, classNames = ["PetsApi"]) {
  const out = tmpDir();
  const outFile = path.join(out, "sdk", "sdk.bundle.js");
  const result = await bundleSdk({
    entry: path.join(root, entry),
    root,
    outFile,
    shimDir: path.join(out, "shim"),
    classNames,
  });
  return { ...result, out, outFile };
}

async function rejection(p: Promise<unknown>): Promise<OagMcpError> {
  try {
    await p;
  } catch (e) {
    return e as OagMcpError;
  }
  throw new Error("expected a rejection");
}

describe("bundle - sdkCompilerOptions", function () {
  it("should target ES2022 modules with the agent libs and no ambient types", function () {
    const o = sdkCompilerOptions();
    assert.equals(o.lib, AGENT_TS_LIBS);
    assert.equals(o.types, []);
    refute(o.allowJs);
  });
});

describe("bundle - bundleSdk", function () {
  this.timeout(30000);

  it("should bundle a source SDK into one ES module exporting the runtime and API classes", async function () {
    const { exports, bytes, outFile } = await bundle(
      SDK_726,
      path.join("src", "index.ts"),
      ["PetsApi", "StoreApi"],
    );
    for (const name of [...REQUIRED_RUNTIME_EXPORTS, "PetsApi", "StoreApi"]) {
      assert.contains(exports, name);
    }
    assert.equals(bytes, fs.statSync(outFile).size);
    assert.match(
      fs.readFileSync(outFile, "utf8"),
      /^\/\/ oag-mcp SDK execution bundle\./,
    );
  });

  it("should bundle a compiled ES module entry as it is", async function () {
    const root = files({
      "dist/index.js":
        "export class Configuration {}\nexport class BaseAPI {}\nexport class PetsApi extends BaseAPI {}\n",
    });
    const { exports, out } = await bundle(root, path.join("dist", "index.js"));
    assert.equals(exports.sort(), ["BaseAPI", "Configuration", "PetsApi"]);
    refute(fs.existsSync(path.join(out, "shim")), "no CommonJS shim");
  });

  it("should re-export a CommonJS entry's names through an ES module shim", async function () {
    const root = files({
      "dist/index.js": [
        '"use strict";',
        "class BaseAPI {}",
        "exports.BaseAPI = BaseAPI;",
        "exports.Configuration = class Configuration {};",
        "exports.ResponseError = class ResponseError extends Error {};",
        'exports.PetsApi = require("./apis").PetsApi;',
      ].join("\n"),
      "dist/apis.js": "exports.PetsApi = class PetsApi {};\n",
    });
    const { exports, out } = await bundle(root, path.join("dist", "index.js"));
    for (const name of [
      "BaseAPI",
      "Configuration",
      "ResponseError",
      "PetsApi",
    ]) {
      assert.contains(exports, name);
    }
    const shim = fs.readFileSync(
      path.join(out, "shim", "__oag_mcp_entry.mjs"),
      "utf8",
    );
    assert.match(shim, /^import __sdk from ".*\/dist\/index\.js";/);
    assert.match(shim, /export const PetsApi = __sdk\.PetsApi;/);
  });

  it("should explain a bundle that cannot be built", async function () {
    const root = files({
      "src/index.ts":
        'import { thing } from "not-installed-pkg";\nexport { thing };\n',
    });
    const err = await rejection(bundle(root, path.join("src", "index.ts")));
    assert.equals(err.code, "SDK_BUNDLE_FAILED");
    assert.match(err.message, /not-installed-pkg/);
    assert.match(err.hint!, /oag-mcp never installs packages/);
  });

  it("should refuse a bundle missing the runtime or API classes", async function () {
    const root = files({ "src/index.ts": "export class Configuration {}\n" });
    const err = await rejection(bundle(root, path.join("src", "index.ts")));
    assert.equals(err.code, "SDK_BUNDLE_EXPORTS");
    assert.match(err.message, /does not export: BaseAPI, PetsApi/);
  });
});

describe("bundle - emitDeclarations", function () {
  this.timeout(30000);

  it("should emit declarations and return non-fatal type errors", function () {
    const root = files({
      "src/index.ts":
        'export const n: number = "not a number";\nexport class PetsApi {}\n',
    });
    const out = tmpDir();
    const messages = emitDeclarations(path.join(root, "src", "index.ts"), out);
    assert(fs.existsSync(path.join(out, "index.d.ts")));
    assert.equals(messages.length, 1);
    assert.match(messages[0], /not assignable to type 'number'/);
  });

  it("should fail when no index declaration is produced", function () {
    const root = files({ "src/main.ts": "export const x = 1;\n" });
    try {
      emitDeclarations(path.join(root, "src", "main.ts"), tmpDir());
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_DECLARATIONS_FAILED");
    }
  });
});

describe("bundle - copyDeclarations", function () {
  it("should copy only declarations, leaving out the ESM build", function () {
    const typesDir = files({
      "index.d.ts": "export {};",
      "index.js": "",
      "apis/PetsApi.d.ts": "export {};",
      "esm/index.d.ts": "export {};",
    });
    const out = tmpDir();
    copyDeclarations(typesDir, out);
    assert(fs.existsSync(path.join(out, "index.d.ts")));
    assert(fs.existsSync(path.join(out, "apis", "PetsApi.d.ts")));
    refute(fs.existsSync(path.join(out, "index.js")));
    refute(fs.existsSync(path.join(out, "esm")));
  });
});

describe("bundle - copyTsLibs", function () {
  it("should copy the agent libs and every lib they reference", function () {
    const out = tmpDir();
    const copied = copyTsLibs(out);
    for (const name of [...AGENT_TS_LIBS, "lib.es5.d.ts", "lib.es2021.d.ts"]) {
      assert.contains(copied, name);
      assert(fs.existsSync(path.join(out, name)), name);
    }
    assert.equals(copied, [...copied].sort());
    assert.equals(new Set(copied).size, copied.length);
  });
});
