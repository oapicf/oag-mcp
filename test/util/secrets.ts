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
