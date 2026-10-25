"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { AgentTypeChecker } from "../../lib/executor/typecheck.js";
import { copyTsLibs } from "../../lib/prepare/bundle.js";
import { tmpDir } from "../helpers/paths.js";

const { assert } = referee;

const BINDING = `/// <reference path="./missing.d.ts" />
import type { Pet } from "petlib";
declare global {
  const sdk: {
    PetsApi: { listPets(req?: { limit?: number }): Promise<Pet[]> };
  };
}
`;

/** An sdk/ directory with a binding, a typed package and the TS libs. */
function sdkDir(): { dir: string; libDir: string } {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "sdk-binding.d.ts"), BINDING);
  const pkg = path.join(dir, "node_modules", "petlib");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "petlib", types: "index.d.ts" }),
  );
  fs.writeFileSync(
    path.join(pkg, "index.d.ts"),
    "export interface Pet { name: string; vaccinated: boolean }\n",
  );
  const libDir = path.join(dir, "ts-lib");
  copyTsLibs(libDir);
  return { dir, libDir };
}

describe("typecheck - AgentTypeChecker", function () {
  this.timeout(30000);
  let checker: AgentTypeChecker;

  before(function () {
    const { dir, libDir } = sdkDir();
    checker = new AgentTypeChecker(dir, libDir);
    checker.warmUp();
  });

  it("should accept code that uses the sdk binding correctly", function () {
    assert.equals(
      checker.check(
        "const pets = await sdk.PetsApi.listPets({ limit: 5 });\nreturn pets.filter((p) => p.vaccinated).map((p) => p.name);",
      ),
      [],
    );
  });

  it("should report type errors in the agent's own coordinates", function () {
    const [d, ...rest] = checker.check(
      "const pets = await sdk.PetsApi.listPets();\nreturn pets[0].age;",
    );
    assert.equals(rest, []);
    assert.equals(d.line, 2);
    assert.equals(d.code, 2339);
    assert.match(d.message, /Property 'age' does not exist on type 'Pet'/);
  });

  it("should report syntax errors and check each version of the code afresh", function () {
    assert.greater(checker.check("return (;").length, 0);
    assert.equals(checker.check("return 1;"), []);
  });

  it("should report at most ten errors", function () {
    const code = Array.from({ length: 15 }, (_, i) => `sdk.Nope${i}();`).join(
      "\n",
    );
    assert.equals(checker.check(code).length, 10);
  });
});
