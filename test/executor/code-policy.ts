"use strict";
import referee from "@sinonjs/referee";

import ts from "typescript";

import {
  findViolations,
  mapDiagnostic,
  prepareCode,
  wrapForExecution,
  wrapForTypecheck,
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

describe("code-policy - findViolations module syntax", function () {
  it("should find import and export-from declarations and import-equals", function () {
    assert.equals(
      findViolations(
        'import fs from "node:fs";\nexport * from "./x";\nimport cp = require("child_process");',
        "typescript",
      ),
      [
        "module import at line 1",
        "module import at line 2",
        "module import at line 3",
      ],
    );
  });

  it("should allow local exports without a module", function () {
    assert.equals(
      findViolations("const a = 1;\nexport { a };", "typescript"),
      [],
    );
  });
});

describe("code-policy - wrapForTypecheck", function () {
  it("should wrap agent code as the body of an async function in a module", function () {
    const src = wrapForTypecheck("return 1;");
    assert.equals(src.split("\n")[1], "return 1;");
    assert.match(src, /^export \{\}; async function/);
  });
});

describe("code-policy - mapDiagnostic", function () {
  it("should report a diagnostic without a source position at line 0", function () {
    assert.equals(
      mapDiagnostic({
        category: ts.DiagnosticCategory.Error,
        code: 1234,
        file: undefined,
        start: undefined,
        length: undefined,
        messageText: {
          messageText: "outer",
          category: 1,
          code: 1,
          next: [{ messageText: "inner", category: 1, code: 2 }],
        },
      } as ts.Diagnostic),
      { line: 0, column: 0, code: 1234, message: "outer\n  inner" },
    );
  });
});
