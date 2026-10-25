"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import sinon from "sinon";
import * as tar from "tar";

import {
  ARCHIVE_LIMITS,
  extractArchive,
  missingDependencies,
  stageSdkInput,
  unsafeArchivePath,
} from "../../lib/prepare/sdk-input.js";
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
    assert.equals(unsafeArchivePath(""), "empty or NUL-containing path");
    assert.equals(
      unsafeArchivePath("package/a\0b"),
      "empty or NUL-containing path",
    );
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
  it("should use a directory in place without copying or modifying it", async function () {
    const before = sha256Tree(SDK_726);
    const work = tmpDir();
    const staged = await stageSdkInput(SDK_726, work);
    assert.equals(staged.kind, "directory");
    assert.equals(staged.root, fs.realpathSync(SDK_726));
    assert.equals(fs.readdirSync(work), []);
    assert.equals(sha256Tree(SDK_726), before);
    assert.equals(staged.sha256, before);
  });

  it("should extract an archive into the workspace", async function () {
    const work = tmpDir();
    const staged = await stageSdkInput(SDK_TGZ, path.join(work, "input"));
    assert.equals(staged.kind, "archive");
    assert(staged.root.startsWith(fs.realpathSync(work)));
    assert.match(staged.sha256, /^[0-9a-f]{64}$/);
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

describe("sdk-input - missingDependencies", function () {
  it("should resolve dependencies from the SDK or any parent node_modules", function () {
    const work = tmpDir();
    const sdk = path.join(work, "apps", "sdk");
    fs.mkdirSync(path.join(sdk, "node_modules", "local-dep"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sdk, "node_modules", "local-dep", "package.json"),
      "{}",
    );
    fs.mkdirSync(path.join(work, "node_modules", "@scope", "hoisted"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(work, "node_modules", "@scope", "hoisted", "package.json"),
      "{}",
    );
    assert.equals(
      missingDependencies(sdk, {
        "local-dep": "1",
        "@scope/hoisted": "1",
        "not-installed-anywhere-xyz": "1",
      }),
      ["not-installed-anywhere-xyz"],
    );
    assert.equals(missingDependencies(sdk, undefined), []);
  });
});

describe("sdk-input - extractArchive limits and extracted tree", function () {
  const saved = { ...ARCHIVE_LIMITS };

  async function packed(): Promise<{ work: string; file: string }> {
    const work = tmpDir();
    fs.mkdirSync(path.join(work, "package", "src"), { recursive: true });
    fs.writeFileSync(path.join(work, "package", "a.txt"), "aaaa");
    fs.writeFileSync(path.join(work, "package", "src", "b.txt"), "bbbb");
    const file = path.join(work, "p.tgz");
    await tar.c({ gzip: true, file, cwd: work }, ["package"]);
    return { work, file };
  }

  afterEach(function () {
    Object.assign(ARCHIVE_LIMITS, saved);
    sinon.restore();
  });

  it("should reject archives over the entry and size limits", async function () {
    const { work, file } = await packed();
    ARCHIVE_LIMITS.maxEntries = 2;
    ARCHIVE_LIMITS.maxTotalBytes = 4;
    try {
      await extractArchive(file, path.join(work, "out"));
      assert(false, "expected failure");
    } catch (e) {
      const err = e as OagMcpError;
      assert.equals(err.code, "SDK_ARCHIVE_UNSAFE");
      assert.match(err.message, /too many entries \(4 > 2\)/);
      assert.match(err.message, /uncompressed size too large \(8 > 4 bytes\)/);
    }
  });

  it("should reject an extracted tree that contains a link", async function () {
    const { work, file } = await packed();
    const readdirSync = fs.readdirSync;
    sinon.stub(fs, "readdirSync").callsFake(((dir: string, opts: never) => {
      const entries = readdirSync(dir, opts) as unknown as fs.Dirent[];
      if (path.basename(dir) !== "package") {
        return entries;
      }
      const link = Object.assign(Object.create(entries[0]), {
        name: "sneaky",
        isSymbolicLink: () => true,
      });
      return [...entries, link];
    }) as typeof fs.readdirSync);
    await expectRejection(
      extractArchive(file, path.join(work, "out")),
      "SDK_ARCHIVE_UNSAFE",
    );
  });

  it("should reject an extracted path that resolves outside the destination", async function () {
    const { work, file } = await packed();
    const realpathSync = fs.realpathSync;
    sinon
      .stub(fs, "realpathSync")
      .callsFake(((p: string) =>
        p.endsWith("b.txt") ? "/elsewhere/b.txt" : realpathSync(p)) as never);
    try {
      await extractArchive(file, path.join(work, "out"));
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_ARCHIVE_UNSAFE");
      assert.match((e as OagMcpError).message, /escapes destination: .*b\.txt/);
    }
  });
});
