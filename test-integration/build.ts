"use strict";
/**
 * Verification 1, 8 and 9: SDK generation/preparation, accurate method
 * indexing, directory and packaged inputs, and artifacts that run without
 * the original SDK/spec.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import * as esbuild from "esbuild";

import { MANIFEST_FILE, readAndVerifyManifest } from "../lib/build/artifact.js";
import { build } from "../lib/build/build.js";
import { OagMcpError } from "../lib/errors.js";
import type { MethodRecord } from "../lib/types.js";
import { sha256Tree } from "../lib/util/hash.js";
import {
  LOCAL,
  SDK_725,
  SDK_726,
  SDK_TGZ,
  SDK_VARIANT,
  SECRET_ENV,
  SPEC,
  artifact,
  defaultArtifact,
  dockerAvailable,
  fileLogs,
  javaAvailable,
  runtimeConfig,
  service,
  workDir,
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

function records(dir: string): MethodRecord[] {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "index", "methods.json"), "utf8"),
  );
}

describe("build - existing SDK inputs", function () {
  it("should prepare a source SDK directory and index every method accurately", async function () {
    const dir = await defaultArtifact();
    const m = readAndVerifyManifest(dir);
    assert.equals(m.target.generator, "typescript-fetch");
    assert.equals(m.target.oagVersion, "7.26.0");
    assert.equals(m.target.sdkLayout, "source");
    assert.equals(m.inputs.sdk.kind, "directory");
    assert.match(m.inputs.spec.sha256, /^[0-9a-f]{64}$/);
    const rs = records(dir);
    assert.equals(rs.map((r) => r.id).sort(), EXPECTED_IDS);
    const visits = rs.find((r) => r.id === "PetsApi.listPetVisits")!;
    assert.equals(visits.operationId, "list-pet-visits");
    assert.equals(visits.httpMethod, "GET");
    assert.equals(visits.path, "/pets/{petId}/visits");
    assert.equals(visits.requiredArguments, ["petId"]);
    assert.match(
      visits.signature,
      /^listPetVisits\(requestParameters: ListPetVisitsRequest/,
    );
    assert.equals(visits.auth.alternatives.length, 2);
    for (const f of [
      "sdk/sdk.bundle.js",
      "sdk/sdk-binding.d.ts",
      "sdk/types/index.d.ts",
      "executor/runner.js",
      "index/search-index.json",
    ]) {
      assert(fs.existsSync(path.join(dir, f)), f);
      assert.isString(m.files[f], f);
    }
  });

  it("should prepare a packaged SDK archive in both compiled and source layouts", async function () {
    const compiled = await artifact("tgz-compiled", {
      spec: SPEC,
      sdk: SDK_TGZ,
      sdkLayout: "compiled",
    });
    const source = await artifact("tgz-source", { spec: SPEC, sdk: SDK_TGZ });
    assert.equals(readAndVerifyManifest(compiled).target.sdkLayout, "compiled");
    assert.equals(readAndVerifyManifest(compiled).inputs.sdk.kind, "archive");
    assert.equals(readAndVerifyManifest(source).target.sdkLayout, "source");
    assert.equals(
      records(compiled)
        .map((r) => r.id)
        .sort(),
      EXPECTED_IDS,
    );
    assert.equals(
      records(compiled)
        .map((r) => r.signature)
        .sort(),
      records(await defaultArtifact())
        .map((r) => r.signature)
        .sort(),
    );
  });

  it("should support the other tested generator version and option variant", async function () {
    const v725 = await artifact("source-7.25.0", { spec: SPEC, sdk: SDK_725 });
    const variant = await artifact("variant", { spec: SPEC, sdk: SDK_VARIANT });
    assert.equals(readAndVerifyManifest(v725).target.oagVersion, "7.25.0");
    const vm = readAndVerifyManifest(variant);
    assert.equals(vm.target.options.withInterfaces, true);
    assert.equals(
      records(variant)
        .map((r) => r.id)
        .sort(),
      EXPECTED_IDS,
    );
    assert.match(
      records(variant).find((r) => r.id === "PetsApi.getPetById")!.signature,
      /getPetById\(petId: number/,
    );
  });

  it("should never modify the supplied SDK", async function () {
    const before = sha256Tree(SDK_726);
    await artifact("unmodified-check", { spec: SPEC, sdk: SDK_726 });
    assert.equals(sha256Tree(SDK_726), before);
    refute(fs.existsSync(path.join(SDK_726, "dist")));
  });

  it("should not embed secrets in the artifact", async function () {
    const dir = await defaultArtifact();
    const all = fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"))
      .join("\n");
    for (const v of Object.values(SECRET_ENV)) {
      refute.contains(all, v);
    }
  });

  it("should refuse to overwrite a non-artifact directory and require --force for artifacts", async function () {
    const out = workDir("not-artifact");
    fs.writeFileSync(path.join(out, "keep.txt"), "x");
    try {
      await build({ spec: SPEC, sdk: SDK_726, out, logs: fileLogs().logs });
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "OUT_DIR_NOT_EMPTY");
    }
    const art = await defaultArtifact();
    try {
      await build({
        spec: SPEC,
        sdk: SDK_726,
        out: art,
        logs: fileLogs().logs,
      });
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "OUT_DIR_EXISTS");
    }
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
    try {
      await build({
        spec,
        sdk: SDK_726,
        out: path.join(dir, "out"),
        logs: fileLogs().logs,
      });
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_SPEC_MISMATCH");
      assert.match((e as Error).message, /getStoreInventory/);
    }
    refute(fs.existsSync(path.join(dir, "out")));
  });

  it("should detect a tampered artifact at startup", async function () {
    const src = await defaultArtifact();
    const copy = path.join(workDir("tamper"), "art");
    fs.cpSync(src, copy, { recursive: true });
    fs.appendFileSync(
      path.join(copy, "sdk", "sdk.bundle.js"),
      "\n// tampered\n",
    );
    try {
      readAndVerifyManifest(copy);
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "ARTIFACT_INTEGRITY");
    }
  });
});

describe("build - artifact independence", function () {
  it("should run after the original SDK and spec paths are unavailable", async function () {
    const dir = workDir("independent");
    const sdkCopy = path.join(dir, "sdk-src");
    const specCopy = path.join(dir, "openapi.yaml");
    fs.cpSync(SDK_726, sdkCopy, { recursive: true });
    fs.copyFileSync(SPEC, specCopy);
    const out = path.join(dir, "art");
    await build({ spec: specCopy, sdk: sdkCopy, out, logs: fileLogs().logs });
    fs.rmSync(sdkCopy, { recursive: true });
    fs.rmSync(specCopy);
    const moved = path.join(workDir("moved"), "server");
    fs.renameSync(out, moved);
    const api = await startMockApi();
    try {
      const svc = await service(moved, runtimeConfig(api));
      const res = await svc.execute(
        {
          code: "const p = await sdk.PetsApi.listPets({ limit: 2 });\nreturn p.map((x) => x.name);",
        },
        LOCAL,
      );
      assert.isTrue(res.ok, JSON.stringify(res.error));
      assert.equals(res.result, ["Biscuit", "Mochi"]);
    } finally {
      await api.close();
    }
  });
});

describe("build - SDK generation", function () {
  it("should generate the SDK with the Java backend and keep it usable independently", async function () {
    const java = javaAvailable();
    if (!java.ok) {
      console.log(`      [blocked: ${java.reason}]`);
      this.skip();
    }
    this.timeout(240000);
    const dir = await artifact("generated-java", {
      spec: SPEC,
      generateSdk: true,
      oagVersion: "7.26.0",
      oagBackend: "java",
    });
    const m = readAndVerifyManifest(dir);
    assert.equals(m.inputs.sdk.kind, "generated");
    assert.equals(m.tools.openapiGenerator, {
      version: "7.26.0",
      backend: "java",
    });
    assert.equals(m.target.optionsSource, "generator-arguments");
    assert.equals(
      records(dir)
        .map((r) => r.id)
        .sort(),
      EXPECTED_IDS,
    );
    // The generated SDK package works in an ordinary Node application.
    const pkg = path.join(dir, "sdk-package");
    assert(fs.existsSync(path.join(pkg, "package.json")));
    const api = await startMockApi();
    try {
      const app = path.join(workDir("app"), "app.mts");
      fs.writeFileSync(
        app,
        `import { Configuration, PetsApi } from ${JSON.stringify(path.join(pkg, "src", "index.ts"))};\n` +
          `const api = new PetsApi(new Configuration({ basePath: ${JSON.stringify(api.baseUrl)}, apiKey: process.env.PC_API_KEY }));\n` +
          `const pets = await api.listPets({ species: "dog" });\nconsole.log(JSON.stringify(pets.map((p) => p.name)));\n`,
      );
      // Build the app the way an ordinary application would bundle the SDK.
      const bundled = app.replace(/\.mts$/, ".mjs");
      await esbuild.build({
        entryPoints: [app],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: bundled,
        logLevel: "silent",
      });
      // Async spawn: the mock API runs in this process and must keep serving.
      const res = await new Promise<{ code: number; out: string; err: string }>(
        (resolve) => {
          const child = spawn(process.execPath, [bundled], {
            env: { ...process.env },
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
        },
      );
      assert.equals(res.code, 0, res.err);
      assert.equals(JSON.parse(res.out.trim()), ["Biscuit", "Ziggy", "Maple"]);
    } finally {
      await api.close();
    }
  });

  it("should generate the SDK with the Docker backend", async function () {
    const docker = dockerAvailable();
    if (!docker.ok) {
      console.log(`      [blocked: ${docker.reason}]`);
      this.skip();
    }
    this.timeout(300000);
    const dir = await artifact("generated-docker", {
      spec: SPEC,
      generateSdk: true,
      oagVersion: "7.26.0",
      oagBackend: "docker",
    });
    assert.equals(readAndVerifyManifest(dir).tools.openapiGenerator, {
      version: "7.26.0",
      backend: "docker",
    });
  });

  it("should reject non-exact or untested generator versions", async function () {
    for (const v of ["latest", "7.0.0"]) {
      try {
        await build({
          spec: SPEC,
          generateSdk: true,
          oagVersion: v,
          out: path.join(workDir("v"), "o"),
          logs: fileLogs().logs,
        });
        assert(false);
      } catch (e) {
        assert.match(
          (e as OagMcpError).code,
          /OAG_VERSION_(UNSUPPORTED|INVALID)/,
        );
      }
    }
  });

  it("should leave artifacts with a manifest at the root", async function () {
    const dir = await defaultArtifact();
    assert(fs.existsSync(path.join(dir, MANIFEST_FILE)));
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    assert.equals(pkg.private, true);
    assert.isString(pkg.dependencies["oag-mcp"]);
  });
});
