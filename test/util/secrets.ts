"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { OagMcpError } from "../../lib/errors.js";
import { SecretResolver } from "../../lib/util/secrets.js";
import { tmpDir } from "../helpers/paths.js";

const { assert } = referee;

describe("secrets - SecretResolver", function () {
  it("should resolve environment references without exposing values in errors", function () {
    const r = new SecretResolver({
      baseDir: process.cwd(),
      env: { A: "value-a" },
    });
    assert.equals(r.resolve({ env: "A" }, "x"), "value-a");
    try {
      r.resolve({ env: "B" }, "label");
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SECRET_NOT_FOUND");
    }
  });

  it("should read a protected secrets file and refuse a world-readable one", function () {
    if (process.platform === "win32") this.skip();
    const dir = tmpDir();
    const file = path.join(dir, "secrets.yaml");
    fs.writeFileSync(file, "admin_password: from-file-123\n", { mode: 0o600 });
    assert.equals(
      new SecretResolver({ secretsFile: "secrets.yaml", baseDir: dir }).resolve(
        { secret: "admin_password" },
        "x",
      ),
      "from-file-123",
    );
    fs.chmodSync(file, 0o644);
    try {
      new SecretResolver({ secretsFile: "secrets.yaml", baseDir: dir }).resolve(
        { secret: "admin_password" },
        "x",
      );
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SECRETS_FILE_PERMISSIONS");
    }
  });
});

describe("secrets - SecretResolver secrets file", function () {
  const write = (body: string) => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "secrets.yaml"), body, { mode: 0o600 });
    return new SecretResolver({ secretsFile: "secrets.yaml", baseDir: dir });
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as OagMcpError).code;
    }
    return undefined;
  };

  it("should read the file once and keep using its values", function () {
    const dir = tmpDir();
    const file = path.join(dir, "secrets.yaml");
    fs.writeFileSync(file, "a: one\nb: two\n", { mode: 0o600 });
    const r = new SecretResolver({ secretsFile: file, baseDir: "/elsewhere" });
    assert.equals(r.resolve({ secret: "a" }, "x"), "one");
    fs.rmSync(file);
    assert.equals(r.resolve({ secret: "b" }, "x"), "two");
  });

  it("should require a configured secrets file for secret references", function () {
    const r = new SecretResolver({ baseDir: process.cwd() });
    assert.equals(
      code(() => r.resolve({ secret: "a" }, "x")),
      "SECRETS_FILE_MISSING",
    );
  });

  it("should report a secrets file that cannot be read", function () {
    const r = new SecretResolver({
      secretsFile: "missing.yaml",
      baseDir: tmpDir(),
    });
    assert.equals(
      code(() => r.resolve({ secret: "a" }, "x")),
      "SECRETS_FILE_MISSING",
    );
  });

  it("should require a mapping of keys to string values", function () {
    assert.equals(
      code(() => write("- a\n- b\n").resolve({ secret: "a" }, "x")),
      "SECRETS_FILE_INVALID",
    );
    assert.equals(
      code(() => write("42\n").resolve({ secret: "a" }, "x")),
      "SECRETS_FILE_INVALID",
    );
    const r = write("number: 42\nempty: ''\nok: yes-string\n");
    assert.equals(r.resolve({ secret: "ok" }, "x"), "yes-string");
    assert.equals(
      code(() => r.resolve({ secret: "number" }, "x")),
      "SECRET_NOT_FOUND",
    );
    assert.equals(
      code(() => r.resolve({ secret: "empty" }, "x")),
      "SECRET_NOT_FOUND",
    );
    assert.equals(
      code(() => r.resolve({ secret: "absent" }, "x")),
      "SECRET_NOT_FOUND",
    );
    assert.equals(
      code(() => write("").resolve({ secret: "a" }, "x")),
      "SECRET_NOT_FOUND",
      "an empty file has no secrets",
    );
  });
});
