"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import {
  SdkAnalyzer,
  normaliseName,
  scanImplementation,
} from "../../lib/prepare/analyze.js";
import { emitDeclarations } from "../../lib/prepare/bundle.js";
import { inspectSdk } from "../../lib/prepare/compat.js";
import {
  buildRecords,
  hintsForOperation,
  normalisePathTemplate,
  summariseAuth,
} from "../../lib/prepare/index-builder.js";
import { loadSpec } from "../../lib/prepare/spec.js";
import { OagMcpError } from "../../lib/errors.js";
import type { MethodRecord, SpecSummary } from "../../lib/types.js";
import {
  SDK_726,
  SDK_VARIANT,
  SPEC,
  copyFixture,
  tmpDir,
} from "../helpers/paths.js";

const { assert } = referee;

async function analyse(sdkDir: string, spec: SpecSummary) {
  const insp = inspectSdk(sdkDir);
  const types = path.join(tmpDir(), "types");
  emitDeclarations(insp.entry, types);
  const impl = scanImplementation(insp.apiFiles);
  const byKey = new Map(spec.operations.map((o) => [o.key, o]));
  const methods = new SdkAnalyzer(path.join(types, "index.d.ts")).analyze(
    impl,
    (m, p) => hintsForOperation(byKey.get(`${m} ${p}`)),
  );
  return { impl, methods };
}

describe("analyze - scanImplementation", function () {
  it("should read HTTP method and path templates from RequestOpts implementations", function () {
    const insp = inspectSdk(SDK_726);
    const impl = scanImplementation(insp.apiFiles);
    assert.equals([...impl.keys()].sort(), [
      "AdminApi",
      "OwnersApi",
      "PetsApi",
      "StoreApi",
    ]);
    assert.equals(impl.get("PetsApi")!.get("listPetVisits"), {
      httpMethod: "GET",
      path: "/pets/{petId}/visits",
      source: "RequestOpts",
    });
    assert.equals(impl.get("AdminApi")!.get("deletePet")!.httpMethod, "DELETE");
  });

  it("should fall back to Raw implementations used by older generator output", function () {
    const dir = tmpDir();
    const file = path.join(dir, "LegacyApi.ts");
    fs.writeFileSync(
      file,
      `import * as runtime from '../runtime';
export class LegacyApi extends runtime.BaseAPI {
  async getThingRaw(requestParameters: any): Promise<any> {
    const response = await this.request({
      path: \`/things/{${"thingId"}}\`.replace(\`{${"thingId"}}\`, encodeURIComponent(String(requestParameters.thingId))),
      method: 'GET',
      headers: {},
    });
    return response;
  }
}`,
    );
    const impl = scanImplementation([file]);
    assert.equals(impl.get("LegacyApi")!.get("getThing"), {
      httpMethod: "GET",
      path: "/things/{thingId}",
      source: "Raw",
    });
  });
});

describe("analyze - SdkAnalyzer.analyze", function () {
  it("should bind methods whose names differ from operationIds without assuming equality", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const { records } = buildRecords(spec, methods);
    const byId = new Map(records.map((r) => [r.id, r]));
    assert.equals(
      byId.get("PetsApi.listPetVisits")!.operationId,
      "list-pet-visits",
    );
    assert.equals(
      byId.get("StoreApi.getStoreInventory")!.operationId,
      "get-store-inventory",
    );
    assert.isUndefined(byId.get("AdminApi.healthGet")!.operationId);
    assert.equals(byId.get("AdminApi.healthGet")!.path, "/health");
  });

  it("should extract signatures, required arguments, referenced types and examples", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const create = methods.find((m) => m.methodName === "createPet")!;
    assert.match(
      create.signature,
      /^createPet\(requestParameters: CreatePetRequest/,
    );
    assert.equals(create.requestStyle, "object");
    assert.equals(create.requiredArguments, ["newPet"]);
    assert.equals(create.returnType, "Promise<Pet>");
    assert.match(create.inputType!.declaration, /newPet: NewPet/);
    const names = create.referencedTypes.map((t) => t.name);
    assert.contains(names, "Pet");
    assert.contains(names, "Species");
    assert.match(
      create.referencedTypes.find((t) => t.name === "Species")!.declaration,
      /"dog" \| "cat"/,
    );
    assert.match(
      create.example,
      /sdk\.PetsApi\.createPet\(\{ newPet: \{ name: "Biscuit", species: "dog" \} \}\)/,
    );
  });

  it("should describe positional signatures for useSingleRequestParameter=false", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_VARIANT, spec);
    const list = methods.find((m) => m.methodName === "listPets")!;
    assert.equals(list.requestStyle, "positional");
    assert.match(
      list.signature,
      /listPets\(species\?: Species, limit\?: number/,
    );
    const get = methods.find((m) => m.methodName === "getPetById")!;
    assert.equals(get.requiredArguments, ["petId"]);
    assert.match(get.example, /getPetById\(1\)/);
  });

  it("should report ambiguity when a method's HTTP binding cannot be found", async function () {
    const dir = copyFixture(SDK_726);
    const file = path.join(dir, "src", "apis", "StoreApi.ts");
    // Remove the literal path so the binding can no longer be determined.
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(
          "let urlPath = `/store/inventory`;",
          "let urlPath = computePath();",
        ),
    );
    const spec = await loadSpec(SPEC);
    try {
      await analyse(dir, spec);
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_BINDING_AMBIGUOUS");
      assert.match((e as OagMcpError).message, /StoreApi\.getStoreInventory/);
    }
  });
});

describe("index-builder - buildRecords", function () {
  it("should fail when the SDK has methods the spec does not define", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const trimmed = {
      ...spec,
      operations: spec.operations.filter((o) => o.operationId !== "listOwners"),
    };
    try {
      buildRecords(trimmed, methods);
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_SPEC_MISMATCH");
    }
  });

  it("should report operations without SDK methods as unmapped", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const { unmapped, records } = buildRecords(
      spec,
      methods.filter((m) => m.methodName !== "healthGet"),
    );
    assert.equals(unmapped, [{ key: "GET /health", operationId: undefined }]);
    assert.equals(records.length, 10);
  });

  it("should detect a binding that matches several operations", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const extra = {
      ...spec.operations.find((o) => o.key === "GET /pets/{petId}")!,
    };
    const dup = {
      ...spec,
      operations: [
        ...spec.operations.filter((o) => o.key !== "GET /pets/{petId}"),
        { ...extra, key: "GET /pets/{id}", path: "/pets/{id}" },
        { ...extra, key: "GET /pets/{x}", path: "/pets/{x}" },
      ],
    };
    try {
      buildRecords(dup, methods);
      assert(false, "expected failure");
    } catch (e) {
      assert.match((e as OagMcpError).message, /matches several operations/);
    }
  });

  it("should summarise auth alternatives and optional auth", function () {
    const schemes = {
      a: {
        name: "a",
        type: "apiKey" as const,
        in: "header" as const,
        supported: true,
      },
      c: { name: "c", type: "openIdConnect" as const, supported: false },
    };
    const s = summariseAuth([{ a: [] }, {}], schemes);
    assert.isTrue(s.optional);
    assert.equals(s.alternatives[0].schemes[0].type, "apiKey-header");
    assert.equals(summariseAuth([{ c: [] }], schemes).unsupportedSchemes, [
      "c",
    ]);
    assert.equals(normalisePathTemplate("/a/{b}/c/"), "/a/{}/c");
    assert.equals(normaliseName("Pet_ID"), "petid");
  });

  it("should give every record an id, sdk path and auth summary", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const { records, bindings } = buildRecords(spec, methods);
    for (const r of records as MethodRecord[]) {
      assert.equals(r.sdkPath, `sdk.${r.className}.${r.methodName}`);
      assert.equals(r.id, `${r.className}.${r.methodName}`);
    }
    assert.equals(bindings.length, records.length);
  });
});
