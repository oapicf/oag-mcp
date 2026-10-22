"use strict";
import referee from "@sinonjs/referee";

import {
  findViolations,
  prepareCode,
  wrapForExecution,
} from "../../lib/executor/code-policy.js";

const { assert } = referee;

describe("code-policy - findViolations", function () {
  it("should find dynamic import, import.meta and require with agent line numbers", function () {
    const v = findViolations(
      'const a = 1;\nconst m = await import("node:fs");\nconst u = import.meta.url;\nrequire("x");',
      "javascript",
    );
    assert.equals(v, [
      "dynamic import() at line 2",
      "import.meta at line 3",
      "require() at line 4",
    ]);
  });

  it("should accept ordinary SDK code", function () {
    assert.equals(
      findViolations(
        "const p = await sdk.PetsApi.listPets({});\nreturn p.length;",
        "typescript",
      ),
      [],
    );
  });
});

describe("code-policy - prepareCode", function () {
  it("should transpile TypeScript to a base64 ES module", function () {
    const r = prepareCode(
      "const n: number = 1;\nreturn n;",
      "typescript",
      1000,
    );
    assert.isTrue(r.ok);
    if (r.ok) {
      assert.match(
        r.js,
        /export default async function __oagMcpMain\(sdk, console\)/,
      );
      assert.equals(Buffer.from(r.moduleBase64, "base64").toString(), r.js);
      assert.equals(r.js.includes(": number"), false);
    }
  });

  it("should report syntax errors at agent line numbers", function () {
    const r = prepareCode("const a = 1;\nconst = 2;", "javascript", 1000);
    assert.isFalse(r.ok);
    if (!r.ok) {
      assert.equals(r.error.type, "syntax_error");
      assert.equals(r.error.diagnostics![0].line, 2);
    }
  });

  it("should reject imports", function () {
    const r = prepareCode(
      'const x = await import("https://example.com/x.js");',
      "typescript",
      1000,
    );
    assert.isFalse(r.ok);
    if (!r.ok) {
      assert.equals(r.error.type, "permission_denied");
      assert.equals(r.error.reason, "import_not_allowed");
    }
  });

  it("should reject code above the size limit", function () {
    const r = prepareCode("x".repeat(2000), "javascript", 1000);
    assert.isFalse(r.ok);
    if (!r.ok) assert.equals(r.error.type, "resource_limit");
  });

  it("should keep the one-line wrapper header the diagnostics mapping assumes", function () {
    assert.equals(wrapForExecution("X").split("\n")[1], "X");
  });
});
