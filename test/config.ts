"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import { browserOrigin, loadConfig, parseConfig } from "../lib/config.js";
import { OagMcpError } from "../lib/errors.js";
import { tmpDir } from "./helpers/paths.js";

const { assert } = referee;

describe("config - parseConfig", function () {
  it("should apply safe defaults", function () {
    const c = parseConfig({});
    assert.equals(c.http.host, "127.0.0.1");
    assert.equals(c.mcpAuth.mode, "none");
    assert.equals(c.execution.timeoutMs, 30000);
    assert.isUndefined(c.authorization);
  });

  it("should reject inline secret values", function () {
    try {
      parseConfig({
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
      parseConfig({ mcpauth: {} });
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "CONFIG_INVALID");
    }
  });

  it("should keep mcpAuth and upstreamAuth separate", function () {
    const c = parseConfig({
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
    const { config, baseDir } = loadConfig(file);
    assert.equals(config.upstream.baseUrl, "http://127.0.0.1:9/v1");
    assert.equals(baseDir, dir);
    try {
      loadConfig(path.join(dir, "missing.yaml"));
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "CONFIG_NOT_FOUND");
    }
  });
});

describe("config - loadConfig defaults and parse errors", function () {
  it("should use defaults relative to the working directory without a file", function () {
    const { config, baseDir } = loadConfig();
    assert.equals(config, parseConfig({}));
    assert.equals(baseDir, process.cwd());
  });

  it("should reject a file that is not YAML or JSON", function () {
    const file = path.join(tmpDir(), "bad.yaml");
    fs.writeFileSync(file, "a: [unclosed");
    try {
      loadConfig(file);
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "CONFIG_INVALID");
      assert.match((e as OagMcpError).message, /is not valid YAML\/JSON/);
    }
  });
});

describe("config - http.allowedOrigins", function () {
  it("should accept origins and reject hostnames, paths and other URL parts", function () {
    assert.equals(
      parseConfig({
        http: {
          allowedOrigins: [
            "https://app.example.test",
            "http://localhost:5173/",
            "chrome-extension://abcdef",
          ],
        },
      }).http.allowedOrigins.length,
      3,
    );
    for (const bad of [
      "app.example.test",
      "https://app.example.test/path",
      "https://user:pw@app.example.test",
      "https://app.example.test?x=1",
      "https://app.example.test#",
      "*",
    ]) {
      try {
        parseConfig({ http: { allowedOrigins: [bad] } });
        assert(false, bad);
      } catch (e) {
        assert.equals((e as OagMcpError).code, "CONFIG_INVALID", bad);
        assert.match((e as OagMcpError).message, /must be an origin/, bad);
      }
    }
  });
});

describe("config - browserOrigin", function () {
  it("should normalise origins the way browsers send them", function () {
    assert.equals(
      browserOrigin("https://App.Example.test:443/"),
      "https://app.example.test",
    );
    assert.equals(
      browserOrigin("http://localhost:5173"),
      "http://localhost:5173",
    );
    assert.equals(browserOrigin("http://[::1]:80"), "http://[::1]");
    assert.isUndefined(browserOrigin("null"));
    assert.isUndefined(browserOrigin(""));
  });
});
