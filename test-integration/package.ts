"use strict";
/**
 * The npm package installs and the installed CLI serves directly from
 * --spec and --sdk, with no build step or artifact directory.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import referee from "@sinonjs/referee";

import {
  ROOT,
  SDK_TGZ,
  SECRET_ENV,
  SPEC,
  upstreamAuthConfig,
  workDir,
  writeConfig,
} from "./helpers/env.js";
import { startMockApi } from "./helpers/mock-api.js";

const { assert } = referee;

describe("package - npm pack and global install", function () {
  it("should install from the packed tarball and serve directly from the installed CLI", async function () {
    this.timeout(600000);
    const ping = spawnSync("npm", ["ping"], {
      encoding: "utf8",
      timeout: 30000,
    });
    if (ping.status !== 0) {
      console.log(
        "      [blocked: npm registry unreachable; dependencies cannot be installed]",
      );
      this.skip();
    }
    const dir = workDir("pack");
    const pack = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", dir],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equals(pack.status, 0, pack.stderr);
    const info = JSON.parse(pack.stdout)[0];
    const files: string[] = info.files.map((f: { path: string }) => f.path);
    assert.contains(files, "bin/oag-mcp.js");
    assert.contains(files, "dist/cli.js");
    assert.contains(files, "assets/deno-runner.js");
    assert.contains(files, "conf/commands.json");
    assert.equals(
      files.some((f) => f.startsWith("test/") || f.startsWith("lib/")),
      false,
    );
    const prefix = path.join(dir, "prefix");
    const install = spawnSync(
      "npm",
      [
        "install",
        "-g",
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        path.join(dir, info.filename),
      ],
      {
        encoding: "utf8",
        timeout: 540000,
      },
    );
    assert.equals(install.status, 0, install.stderr);
    const bin = path.join(
      prefix,
      process.platform === "win32"
        ? "oag-mcp.cmd"
        : path.join("bin", "oag-mcp"),
    );
    assert(fs.existsSync(bin), bin);
    const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
    assert.equals(
      version.stdout.trim(),
      JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
        .version,
    );
    const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
    assert.equals(help.stdout.includes("build"), false, help.stdout);
    assert.equals(
      files.some((f) => f.startsWith("scripts/")),
      false,
    );

    const api = await startMockApi();
    try {
      const config = writeConfig(dir, {
        upstream: { baseUrl: api.baseUrl },
        upstreamAuth: upstreamAuthConfig(),
      });
      const client = new Client({ name: "pkg", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: bin,
          args: [
            "serve",
            "--spec",
            SPEC,
            "--sdk",
            SDK_TGZ,
            "--sdk-layout",
            "compiled",
            "--transport",
            "stdio",
            "--config",
            config,
            "--log-level",
            "warn",
          ],
          env: { ...(process.env as Record<string, string>), ...SECRET_ENV },
          stderr: "ignore",
        }),
      );
      const res = await client.callTool({
        name: "execute",
        arguments: {
          code: `return (await sdk.PetsApi.listPets({ limit: 3 })).map((p) => p.name);`,
        },
      });
      assert.equals((res.structuredContent as { result: unknown }).result, [
        "Biscuit",
        "Mochi",
        "Pepper",
      ]);
      await client.close();
    } finally {
      await api.close();
    }
  });
});
