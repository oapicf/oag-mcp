"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { listFiles, sha256Tree } from "../../lib/util/hash.js";
import { tmpDir } from "../helpers/paths.js";

const { assert, refute } = referee;

function tree(): string {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "src", "apis"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  fs.writeFileSync(path.join(dir, "src", "apis", "A.ts"), "a");
  fs.writeFileSync(path.join(dir, "node_modules", "x", "i.js"), "i");
  fs.symlinkSync(path.join(dir, "b.txt"), path.join(dir, "link.txt"));
  return dir;
}

describe("hash - listFiles", function () {
  it("should list files as sorted POSIX paths, skipping links and filtered paths", function () {
    const dir = tree();
    assert.equals(listFiles(dir), [
      "b.txt",
      "node_modules/x/i.js",
      "src/apis/A.ts",
    ]);
    assert.equals(
      listFiles(dir, (rel) => !rel.startsWith("node_modules")),
      ["b.txt", "src/apis/A.ts"],
    );
  });
});

describe("hash - sha256Tree", function () {
  it("should change when any file's content changes", function () {
    const dir = tree();
    const before = sha256Tree(dir);
    assert.equals(sha256Tree(dir), before);
    fs.writeFileSync(path.join(dir, "src", "apis", "A.ts"), "changed");
    refute.equals(sha256Tree(dir), before);
  });
});
