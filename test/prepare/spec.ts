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

describe("spec - loadSpec operation details", function () {
  const write = (body: string) => {
    const file = path.join(tmpDir(), "spec.yaml");
    fs.writeFileSync(file, body);
    return file;
  };

  it("should let operation parameters override path item parameters and keep explicit examples", async function () {
    const spec = await loadSpec(
      write(`openapi: 3.1.0
info: { title: T, version: "1" }
paths:
  /a/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string }, example: shared }
      - { name: q, in: query, schema: { type: integer } }
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string }, example: null }
      responses: { "200": { description: ok }, default: { description: "" } }
`),
    );
    const [op] = spec.operations;
    assert.equals(
      op.parameters.map((p) => [p.name, p.in, p.example]),
      [
        ["id", "path", null],
        ["q", "query", 0],
      ],
    );
    assert.equals(op.responses, { "200": "ok", default: "" });
    assert.isUndefined(op.requestBody);
  });

  it("should describe a request body by its first media type", async function () {
    const spec = await loadSpec(
      write(`openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /a:
    post:
      requestBody: { content: {} }
      responses: { "201": { description: made } }
    put:
      requestBody:
        required: true
        description: body
        content:
          application/json: { schema: { type: string }, example: null }
          text/plain: { schema: { type: integer } }
      responses: { "200": { description: ok } }
`),
    );
    const byMethod = Object.fromEntries(
      spec.operations.map((o) => [o.method, o.requestBody]),
    );
    assert.equals(byMethod.POST, {
      required: false,
      contentTypes: [],
      description: undefined,
      schemaType: "any",
      example: undefined,
    });
    assert.equals(byMethod.PUT, {
      required: true,
      contentTypes: ["application/json", "text/plain"],
      description: "body",
      schemaType: "string",
      example: null,
    });
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
  });

  it("should build request examples from the schema's own values, required properties only and without readOnly properties", function () {
    assert.equals(
      exampleForSchema({
        type: "object",
        required: ["id", "name", "species"],
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string", example: "Rex" },
          species: { type: "string", enum: ["dog", "cat"] },
          age: { type: "integer" },
        },
      }),
      { name: "Rex", species: "dog" },
    );
  });

  it("should generate values that match the schema's format and alternatives", function () {
    assert.match(
      exampleForSchema({ type: "string", format: "date" }),
      /^\d{4}-\d{2}-\d{2}$/,
    );
    assert.match(
      exampleForSchema({ type: "string", format: "email" }),
      /^[^@\s]+@[^@\s]+$/,
    );
    assert.equals(
      exampleForSchema({
        oneOf: [
          {
            type: "object",
            required: ["meow"],
            properties: { meow: { type: "boolean" } },
          },
          {
            type: "object",
            required: ["bark"],
            properties: { bark: { type: "integer" } },
          },
        ],
      }),
      { meow: true },
    );
  });

  it("should return undefined when there is no schema", function () {
    assert.isUndefined(exampleForSchema(undefined));
  });
});

describe("spec - describeSchema composites and depth", function () {
  it("should describe oneOf and anyOf as alternatives and allOf as an intersection", function () {
    assert.equals(
      describeSchema({ oneOf: [{ type: "string" }, { type: "integer" }] }),
      "string | integer",
    );
    assert.equals(
      describeSchema({ anyOf: [{ type: "boolean" }, { type: "null" }] }),
      "boolean | null",
    );
    assert.equals(
      describeSchema({ allOf: [{ properties: {} }, { type: "object" }] }),
      "object & object",
    );
  });

  it("should describe a schema with only properties as an object, and an empty one as any", function () {
    assert.equals(describeSchema({ properties: { a: {} } }), "object");
    assert.equals(describeSchema({}), "any");
    assert.equals(describeSchema(null), "any");
  });

  it("should stop describing nested schemas after a few levels", function () {
    const nested = {
      type: "array",
      items: {
        type: "array",
        items: { type: "array", items: { type: "array", items: {} } },
      },
    };
    assert.equals(describeSchema(nested), "array[][][]");
    assert.equals(
      describeSchema({ oneOf: [{ oneOf: [{ oneOf: [{ oneOf: [{}] }] }] }] }),
      "object",
    );
  });

  it("should give up on an example the sampler cannot produce", function () {
    assert.isUndefined(
      exampleForSchema({ $ref: "#/components/schemas/Missing" }),
    );
  });
});

describe("spec - describeSecurityScheme types", function () {
  it("should support header and query API keys, basic and bearer HTTP, and client credentials", function () {
    assert.isTrue(
      describeSecurityScheme("k", { type: "apiKey", in: "query", name: "k" })
        .supported,
    );
    const bearer = describeSecurityScheme("b", {
      type: "http",
      scheme: "Bearer",
      bearerFormat: "JWT",
      description: "token",
    });
    assert.isTrue(bearer.supported);
    assert.equals(bearer.scheme, "bearer");
    assert.equals(bearer.bearerFormat, "JWT");
    assert.equals(bearer.description, "token");
    const cc = describeSecurityScheme("o", {
      type: "oauth2",
      flows: {
        clientCredentials: {
          tokenUrl: "https://auth.example.test/token",
          scopes: { read: "r" },
        },
      },
    });
    assert.isTrue(cc.supported);
    assert.equals(cc.scopes, ["read"]);
  });

  it("should explain mutualTLS and unknown scheme types", function () {
    const mtls = describeSecurityScheme("m", { type: "mutualTLS" });
    assert.isFalse(mtls.supported);
    assert.match(mtls.unsupportedReason!, /mutualTLS/);
    for (const type of ["custom", "constructor", undefined]) {
      const other = describeSecurityScheme("x", { type });
      assert.isFalse(other.supported);
      assert.match(other.unsupportedReason!, /Unknown security scheme type/);
    }
  });
});

describe("spec - loadSpec servers", function () {
  it("should fill server variables with their defaults and drop trailing slashes", async function () {
    const file = path.join(tmpDir(), "servers.yaml");
    fs.writeFileSync(
      file,
      `openapi: 3.0.3
info: { title: T, version: "1" }
servers:
  - url: https://{region}.example.test/{base}/
    variables:
      region: { default: eu }
      base: { default: v2 }
  - url: http://localhost:8080
paths: {}
`,
    );
    const spec = await loadSpec(file);
    assert.equals(spec.servers, [
      "https://eu.example.test/v2",
      "http://localhost:8080",
    ]);
  });
});
