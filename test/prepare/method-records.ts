"use strict";
import referee from "@sinonjs/referee";

import { OagMcpError } from "../../lib/errors.js";
import type { AnalyzedMethod } from "../../lib/prepare/analyze.js";
import {
  buildRecords,
  hintsForOperation,
  normalisePathTemplate,
  summariseAuth,
} from "../../lib/prepare/method-records.js";
import type { SpecOperation, SpecSummary } from "../../lib/types.js";
import { SCHEMES } from "../helpers/fakes.js";

const { assert } = referee;

function operation(
  method: string,
  path: string,
  overrides: Partial<SpecOperation> = {},
): SpecOperation {
  return {
    key: `${method} ${path}`,
    method,
    path,
    operationId: undefined,
    tags: ["t"],
    deprecated: false,
    parameters: [],
    responses: { "200": "ok" },
    security: [],
    securityIsOverride: false,
    ...overrides,
  };
}

function method(
  name: string,
  httpMethod: string,
  path: string,
  overrides: Partial<AnalyzedMethod> = {},
): AnalyzedMethod {
  return {
    className: "PetsApi",
    methodName: name,
    httpMethod,
    path,
    signature: `${name}(): Promise<void>`,
    parameters: [],
    requestStyle: "none",
    returnType: "Promise<void>",
    referencedTypes: [],
    requiredArguments: [],
    documentation: "",
    deprecated: false,
    example: `return await sdk.PetsApi.${name}();`,
    ...overrides,
  };
}

function spec(operations: SpecOperation[]): SpecSummary {
  return {
    openapiVersion: "3.0.3",
    title: "T",
    apiVersion: "1",
    servers: [],
    tags: [],
    securitySchemes: SCHEMES,
    globalSecurity: [],
    operations,
  };
}

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

describe("method-records - normalisePathTemplate", function () {
  it("should ignore parameter names and trailing slashes", function () {
    assert.equals(normalisePathTemplate("/pets/{petId}/"), "/pets/{}");
    assert.equals(normalisePathTemplate("/"), "/");
  });
});

describe("method-records - hintsForOperation", function () {
  it("should collect parameter and body examples by normalised name", function () {
    assert.equals(hintsForOperation(undefined), {});
    assert.equals(
      hintsForOperation(
        operation("POST", "/pets", {
          parameters: [
            {
              name: "pet-id",
              in: "path",
              required: true,
              schemaType: "integer",
              example: 7,
            },
            { name: "q", in: "query", required: false, schemaType: "string" },
          ],
          requestBody: {
            required: true,
            contentTypes: ["application/json"],
            schemaType: "object",
            example: { name: "Rex" },
          },
        }),
      ),
      { petid: 7, __body: { name: "Rex" } },
    );
  });
});

describe("method-records - summariseAuth", function () {
  it("should name each scheme's type and flag unsupported or undefined schemes", function () {
    const auth = summariseAuth(
      [
        { apiKeyHeader: [], bearerAuth: [] },
        { clinicOAuth: ["pets:write"] },
        { oidc: [] },
        { ghost: [] },
        {},
      ],
      SCHEMES,
    );
    assert.equals(
      auth.alternatives.map((a) => a.schemes.map((s) => s.type)),
      [
        ["apiKey-header", "http-bearer"],
        ["oauth2-client-credentials"],
        ["openIdConnect"],
        ["undefined-scheme"],
      ],
    );
    assert.equals(auth.alternatives[1].schemes[0].scopes, ["pets:write"]);
    assert.isTrue(auth.optional, "an empty requirement makes auth optional");
    assert.equals(auth.unsupportedSchemes, ["ghost", "oidc"]);
  });

  it("should treat no requirements as optional and any requirement as required", function () {
    assert.isTrue(summariseAuth([], SCHEMES).optional);
    assert.isFalse(summariseAuth([{ apiKeyHeader: [] }], SCHEMES).optional);
  });
});

describe("method-records - buildRecords", function () {
  it("should bind methods by exact path, or by path with other parameter names", function () {
    const { records, bindings, unmapped } = buildRecords(
      spec([
        operation("GET", "/pets", {
          operationId: "listPets",
          description: "From the spec",
        }),
        operation("GET", "/pets/{petId}", { deprecated: true }),
        operation("DELETE", "/pets/{petId}"),
      ]),
      [
        method("listPets", "GET", "/pets", { documentation: "From the SDK" }),
        method("getPet", "GET", "/pets/{id}", {
          documentation: "SDK docs",
        }),
      ],
    );
    assert.equals(
      records.map((r) => [r.id, r.path, r.description, r.deprecated]),
      [
        ["PetsApi.listPets", "/pets", "From the spec", false],
        ["PetsApi.getPet", "/pets/{petId}", "SDK docs", true],
      ],
    );
    assert.equals(records[0].sdkPath, "sdk.PetsApi.listPets");
    assert.equals(bindings[0], {
      id: "PetsApi.listPets",
      className: "PetsApi",
      methodName: "listPets",
      httpMethod: "GET",
      path: "/pets",
      operationId: "listPets",
      tags: ["t"],
      security: [],
    });
    assert.equals(unmapped, [
      { key: "DELETE /pets/{petId}", operationId: undefined },
    ]);
  });

  it("should leave out a method's empty documentation", function () {
    const { records } = buildRecords(spec([operation("GET", "/pets")]), [
      method("listPets", "GET", "/pets", { deprecated: true }),
    ]);
    assert.isUndefined(records[0].description);
    assert.isTrue(records[0].deprecated);
  });

  it("should refuse methods that match several operations or none", function () {
    const err = expectCode(
      () =>
        buildRecords(
          spec([operation("GET", "/pets/{a}"), operation("GET", "/pets/{b}")]),
          [
            method("getPet", "GET", "/pets/{id}"),
            method("ghost", "GET", "/ghosts"),
          ],
        ),
      "SDK_SPEC_MISMATCH",
    );
    assert.match(err.message, /PetsApi\.getPet .* matches several operations/);
    assert.match(err.message, /PetsApi\.ghost .* has no matching operation/);
    assert.equals((err.details!.problems as string[]).length, 2);
  });

  it("should refuse an SDK without methods", function () {
    expectCode(
      () => buildRecords(spec([operation("GET", "/pets")]), []),
      "SDK_NO_METHODS",
    );
  });
});
