"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { SdkAnalyzer, scanImplementation } from "../../lib/prepare/analyze.js";
import { emitDeclarations } from "../../lib/prepare/bundle.js";
import { inspectSdk } from "../../lib/prepare/compat.js";
import {
  buildRecords,
  hintsForOperation,
} from "../../lib/prepare/index-builder.js";
import { loadSpec } from "../../lib/prepare/spec.js";
import {
  MethodSearchIndex,
  authLine,
  processTerm,
  splitWords,
} from "../../lib/search/search-index.js";
import type { MethodRecord } from "../../lib/types.js";
import { SDK_726, SPEC, tmpDir } from "../helpers/paths.js";

const { assert } = referee;

let records: MethodRecord[];

before(async function () {
  this.timeout(30000);
  const spec = await loadSpec(SPEC);
  const insp = inspectSdk(SDK_726);
  const types = path.join(tmpDir(), "types");
  emitDeclarations(insp.entry, types);
  const byKey = new Map(spec.operations.map((o) => [o.key, o]));
  const methods = new SdkAnalyzer(path.join(types, "index.d.ts")).analyze(
    scanImplementation(insp.apiFiles),
    (m, p) => hintsForOperation(byKey.get(`${m} ${p}`)),
  );
  records = buildRecords(spec, methods).records;
  assert(fs.existsSync(types));
});

describe("search-index - helpers", function () {
  it("should split identifiers and stem terms", function () {
    assert.equals(splitWords("listPetVisits"), "list pet visits");
    assert.equals(processTerm("Cats"), "cat");
    assert.equals(processTerm("inventories"), "inventory");
    assert.equals(processTerm("the"), null);
    assert.equals(processTerm("address"), "address");
  });
});

describe("search-index - MethodSearchIndex.search", function () {
  it("should rank the relevant method first for natural queries", function () {
    const idx = new MethodSearchIndex(records);
    const all = () => true;
    assert.equals(
      idx.search("vet visits of a pet", { visible: all, limit: 3 }).hits[0].id,
      "PetsApi.listPetVisits",
    );
    assert.equals(
      idx.search("store inventory", { visible: all, limit: 3 }).hits[0].id,
      "StoreApi.getStoreInventory",
    );
    assert.equals(
      idx.search("register a new pet", { visible: all, limit: 3 }).hits[0].id,
      "PetsApi.createPet",
    );
    assert.equals(
      idx.search("get-store-inventory", { visible: all, limit: 1 }).hits[0].id,
      "StoreApi.getStoreInventory",
    );
    assert.contains(
      idx.search("cats", { visible: all, limit: 5 }).hits.map((h) => h.id),
      "PetsApi.listPets",
    );
  });

  it("should return only methods available through the sdk binding", function () {
    const idx = new MethodSearchIndex(records);
    for (const h of idx.search("pet", { visible: () => true, limit: 20 })
      .hits) {
      const r = idx.get(h.id)!;
      assert.equals(h.sdkPath, `sdk.${r.className}.${r.methodName}`);
      assert.equals(h.signature, r.signature);
    }
  });

  it("should bound results and filter by visibility", function () {
    const idx = new MethodSearchIndex(records);
    const res = idx.search("pet", {
      visible: (r) => r.className !== "AdminApi",
      limit: 2,
    });
    assert.equals(res.hits.length, 2);
    assert.greater(res.total, 2);
    for (const h of idx.search("delete pet", {
      visible: (r) => r.className !== "AdminApi",
      limit: 20,
    }).hits) {
      assert.equals(h.id.startsWith("AdminApi"), false);
    }
  });

  it("should round-trip through its serialised form", function () {
    const idx = new MethodSearchIndex(records);
    const loaded = new MethodSearchIndex(records, idx.serialise());
    assert.equals(
      loaded.search("owners city", { visible: () => true, limit: 1 }).hits[0]
        .id,
      idx.search("owners city", { visible: () => true, limit: 1 }).hits[0].id,
    );
  });
});

describe("search-index - MethodSearchIndex.browse", function () {
  it("should group visible methods by API class with bounded lists", function () {
    const idx = new MethodSearchIndex(records);
    const groups = idx.browse({ visible: () => true, perClass: 2 });
    assert.equals(
      groups.map((g) => g.api),
      ["AdminApi", "OwnersApi", "PetsApi", "StoreApi"],
    );
    const pets = groups.find((g) => g.api === "PetsApi")!;
    assert.equals(pets.methods.length, 2);
    assert.equals(pets.more, 3);
    assert.equals(
      idx.browse({ visible: () => true, perClass: 2, tag: "PetsApi" })[0]
        .methods.length,
      5,
    );
  });

  it("should describe auth requirements on one line", function () {
    const listPets = records.find((r) => r.id === "PetsApi.listPets")!;
    assert.equals(
      authLine(listPets),
      "apiKeyHeader(apiKey-header) OR bearerAuth(http-bearer)",
    );
    assert.equals(
      authLine(records.find((r) => r.id === "PetsApi.getPetById")!),
      "none",
    );
  });
});
