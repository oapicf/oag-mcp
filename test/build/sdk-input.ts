"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import * as tar from "tar";

import {
  extractArchive,
  stageSdkInput,
  unsafeArchivePath,
} from "../../lib/build/sdk-input.js";
import { OagMcpError } from "../../lib/errors.js";
import { SDK_726, SDK_TGZ, tmpDir } from "../helpers/paths.js";
import { sha256Tree } from "../../lib/util/hash.js";

const { assert } = referee;

async function expectRejection(
  p: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.equals((e as OagMcpError).code, code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("sdk-input - unsafeArchivePath", function () {
  it("should flag absolute paths and traversal but accept normal entries", function () {
    assert.isString(unsafeArchivePath("/etc/passwd"));
    assert.isString(unsafeArchivePath("C:\\x"));
    assert.isString(unsafeArchivePath("package/../../x"));
    assert.isUndefined(unsafeArchivePath("package/src/index.ts"));
  });
});

describe("sdk-input - extractArchive", function () {
  it("should extract an npm pack archive and return its package root", async function () {
    const root = await extractArchive(SDK_TGZ, path.join(tmpDir(), "out"));
    assert.equals(path.basename(root), "package");
    assert(fs.existsSync(path.join(root, "dist", "index.d.ts")));
  });

  it("should reject archives containing parent traversal", async function () {
    const work = tmpDir();
    fs.mkdirSync(path.join(work, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(work, "a", "evil.txt"), "x");
    const file = path.join(work, "evil.tgz");
    await tar.c(
      { gzip: true, file, cwd: path.join(work, "a", "b"), preservePaths: true },
      ["../evil.txt"],
    );
    await expectRejection(
      extractArchive(file, path.join(work, "out")),
      "SDK_ARCHIVE_UNSAFE",
    );
    assert.isFalse(fs.existsSync(path.join(work, "evil.txt")));
  });

  it("should reject archives containing symbolic links", async function () {
    const work = tmpDir();
    fs.mkdirSync(path.join(work, "package"));
    fs.symlinkSync("/etc/passwd", path.join(work, "package", "link"));
    const file = path.join(work, "link.tgz");
    await tar.c({ gzip: true, file, cwd: work }, ["package"]);
    await expectRejection(
      extractArchive(file, path.join(work, "out")),
      "SDK_ARCHIVE_UNSAFE",
    );
  });

  it("should reject archives with several top-level directories", async function () {
    const work = tmpDir();
    fs.mkdirSync(path.join(work, "one"));
    fs.mkdirSync(path.join(work, "two"));
    fs.writeFileSync(path.join(work, "one", "a"), "1");
    fs.writeFileSync(path.join(work, "two", "b"), "2");
    const file = path.join(work, "multi.tgz");
    await tar.c({ gzip: true, file, cwd: work }, ["one", "two"]);
    await expectRejection(
      extractArchive(file, path.join(work, "out")),
      "SDK_ARCHIVE_LAYOUT",
    );
  });

  it("should reject files that are not archives", async function () {
    const work = tmpDir();
    const file = path.join(work, "fake.tgz");
    fs.writeFileSync(file, "not gzip");
    await expectRejection(
      extractArchive(file, path.join(work, "out")),
      "SDK_ARCHIVE_INVALID",
    );
  });
});

describe("sdk-input - stageSdkInput", function () {
  it("should copy a directory without modifying the original", async function () {
    const before = sha256Tree(SDK_726);
    const work = tmpDir();
    const staged = await stageSdkInput(SDK_726, work);
    assert.equals(staged.kind, "directory");
    fs.writeFileSync(path.join(staged.root, "src", "index.ts"), "// changed");
    assert.equals(sha256Tree(SDK_726), before);
    assert.equals(staged.sha256, before);
  });

  it("should reject inputs that are neither directories nor archives", async function () {
    const work = tmpDir();
    const file = path.join(work, "sdk.zip");
    fs.writeFileSync(file, "x");
    await expectRejection(stageSdkInput(file, work), "SDK_INPUT_UNSUPPORTED");
    await expectRejection(
      stageSdkInput(path.join(work, "missing"), work),
      "SDK_NOT_FOUND",
    );
  });
});
