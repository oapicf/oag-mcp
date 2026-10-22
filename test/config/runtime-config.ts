"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import {
  SecretResolver,
  loadRuntimeConfig,
  parseRuntimeConfig,
} from "../../lib/config/runtime-config.js";
import { OagMcpError } from "../../lib/errors.js";
import { tmpDir } from "../helpers/paths.js";

const { assert } = referee;

describe("runtime-config - parseRuntimeConfig", function () {
  it("should apply safe defaults", function () {
    const c = parseRuntimeConfig({});
    assert.equals(c.http.host, "127.0.0.1");
    assert.equals(c.mcpAuth.mode, "none");
    assert.equals(c.execution.timeoutMs, 30000);
    assert.isUndefined(c.authorization);
  });

  it("should reject inline secret values", function () {
    try {
      parseRuntimeConfig({
        upstreamAuth: {
          schemes: { bearerAuth: { token: "plain-text-token" } },
        },
      });
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "CONFIG_INVALID");
      assert.match((e as OagMcpError).hint, /never written inline/);
    }
  });

  it("should reject unknown keys to catch typos", function () {
    try {
      parseRuntimeConfig({ mcpauth: {} });
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "CONFIG_INVALID");
    }
  });

  it("should keep mcpAuth and upstreamAuth separate", function () {
    const c = parseRuntimeConfig({
      mcpAuth: {
        mode: "static-bearer",
        staticBearer: {
          tokens: [{ principal: "ci", token: { env: "MCP_TOKEN" } }],
        },
      },
      upstreamAuth: {
        schemes: { bearerAuth: { token: { env: "UPSTREAM_TOKEN" } } },
      },
    });
    assert.equals(c.mcpAuth.staticBearer!.tokens[0].token, {
      env: "MCP_TOKEN",
    });
    assert.equals(c.upstreamAuth.schemes.bearerAuth.token, {
      env: "UPSTREAM_TOKEN",
    });
  });

  it("should load YAML files and report missing ones", function () {
    const dir = tmpDir();
    const file = path.join(dir, "c.yaml");
    fs.writeFileSync(file, "upstream:\n  baseUrl: http://127.0.0.1:9/v1\n");
    const { config, baseDir } = loadRuntimeConfig(file);
    assert.equals(config.upstream.baseUrl, "http://127.0.0.1:9/v1");
    assert.equals(baseDir, dir);
    try {
      loadRuntimeConfig(path.join(dir, "missing.yaml"));
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "CONFIG_NOT_FOUND");
    }
  });
});

describe("runtime-config - SecretResolver", function () {
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
