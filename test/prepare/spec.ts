"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { OagMcpError } from "../../lib/errors.js";
import {
  describeSchema,
  describeSecurityScheme,
  exampleForSchema,
  loadSpec,
} from "../../lib/prepare/spec.js";
import { SPEC, tmpDir } from "../helpers/paths.js";

const { assert } = referee;

describe("spec - loadSpec", function () {
  it("should extract operations, tags and servers from the fixture", async function () {
    const spec = await loadSpec(SPEC);
    assert.equals(spec.title, "Pet Clinic API");
    assert.equals(spec.servers, ["http://127.0.0.1:4010/v1"]);
    assert.equals(spec.operations.length, 11);
    const visits = spec.operations.find(
      (o) => o.key === "GET /pets/{petId}/visits",
    )!;
    assert.equals(visits.operationId, "list-pet-visits");
    assert.equals(
      visits.parameters.map((p) => `${p.in}:${p.name}:${p.required}`),
      ["path:petId:true", "query:since:false"],
    );
  });

  it("should apply operation security overrides and global security otherwise", async function () {
    const spec = await loadSpec(SPEC);
    const byId = new Map(
      spec.operations.map((o) => [o.operationId ?? o.key, o]),
    );
    assert.equals(byId.get("listPets")!.security, [
      { apiKeyHeader: [] },
      { bearerAuth: [] },
    ]);
    assert.isFalse(byId.get("listPets")!.securityIsOverride);
    assert.equals(byId.get("getPetById")!.security, []);
    assert.isTrue(byId.get("getPetById")!.securityIsOverride);
    assert.equals(byId.get("createPet")!.security, [
      { clinicOAuth: ["pets:write"] },
    ]);
  });

  it("should mark supported and unsupported security schemes", async function () {
    const spec = await loadSpec(SPEC);
    for (const name of [
      "apiKeyHeader",
      "apiKeyQuery",
      "bearerAuth",
      "adminBasic",
      "clinicOAuth",
    ]) {
      assert.isTrue(spec.securitySchemes[name].supported, name);
    }
    assert.equals(
      spec.securitySchemes.clinicOAuth.tokenUrl,
      "http://127.0.0.1:4011/token",
    );
  });

  it("should reject Swagger 2.0 documents with an actionable error", async function () {
    const dir = tmpDir();
    const file = path.join(dir, "swagger.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        swagger: "2.0",
        info: { title: "x", version: "1" },
        paths: {},
      }),
    );
    let err: unknown;
    try {
      await loadSpec(file);
    } catch (e) {
      err = e;
    }
    assert(err instanceof OagMcpError);
    assert.equals((err as OagMcpError).code, "SPEC_VERSION_UNSUPPORTED");
  });

  it("should report invalid documents with SPEC_INVALID", async function () {
    const dir = tmpDir();
    const file = path.join(dir, "bad.yaml");
    fs.writeFileSync(file, "openapi: 3.0.3\ninfo: {}\npaths: 3\n");
    try {
      await loadSpec(file);
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SPEC_INVALID");
    }
  });
});

describe("spec - describeSecurityScheme", function () {
  it("should flag cookie api keys, digest, openIdConnect and interactive OAuth flows as unsupported", function () {
    assert.isFalse(
      describeSecurityScheme("c", { type: "apiKey", in: "cookie", name: "s" })
        .supported,
    );
    assert.isFalse(
      describeSecurityScheme("d", { type: "http", scheme: "digest" }).supported,
    );
    assert.isFalse(
      describeSecurityScheme("o", {
        type: "openIdConnect",
        openIdConnectUrl: "x",
      }).supported,
    );
    const ac = describeSecurityScheme("a", {
      type: "oauth2",
      flows: {
        authorizationCode: { authorizationUrl: "x", tokenUrl: "y", scopes: {} },
      },
    });
    assert.isFalse(ac.supported);
    assert.match(ac.unsupportedReason, /clientCredentials/);
  });
});

describe("spec - describeSchema/exampleForSchema", function () {
  it("should describe and exemplify common schemas", function () {
    assert.equals(
      describeSchema({ type: "integer", format: "int64" }),
      "integer(int64)",
    );
    assert.equals(
      describeSchema({ type: "array", items: { type: "string" } }),
      "string[]",
    );
    assert.equals(describeSchema({ enum: ["a", "b"] }), '"a" | "b"');
    assert.equals(
      exampleForSchema({ type: "string", format: "date" }),
      "2026-01-31",
    );
    assert.equals(
      exampleForSchema({
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", example: "Rex" },
          age: { type: "integer" },
        },
      }),
      { name: "Rex" },
    );
  });
});
