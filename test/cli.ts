"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import bag from "bagofcli";
import sinon from "sinon";

import cli from "../lib/cli.js";
import { Semaphore } from "../lib/util/semaphore.js";
import { ROOT } from "./helpers/paths.js";

const { assert } = referee;

describe("cli - exec", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("should contain only the serve command with an action", function (done) {
    sinon.stub(bag, "command").value(function (
      base: string,
      actions: { commands: Record<string, { action: unknown }> },
    ) {
      assert.isString(base);
      assert.equals(Object.keys(actions.commands), ["serve"]);
      assert.isFunction(actions.commands.serve.action);
      done();
    });
    cli.exec();
  });

  it("should define every command in conf/commands.json", function () {
    const commands = JSON.parse(
      fs.readFileSync(path.join(ROOT, "conf", "commands.json"), "utf8"),
    );
    assert.equals(Object.keys(commands.commands), ["serve"]);
    const serveOpts = commands.commands.serve.options.map(
      (o: { arg: string }) => o.arg.split(" ")[0],
    );
    for (const removed of [
      "--out",
      "--generate-sdk",
      "--oag-version",
      "--oag-backend",
      "--oag-jar",
      "--no-install",
    ]) {
      assert.isFalse(serveOpts.includes(removed), removed);
    }
    assert.isUndefined(commands.commands.serve.args);
    for (const flag of [
      "--spec",
      "--sdk",
      "--sdk-layout",
      "--transport",
      "--port",
      "--config",
    ]) {
      assert.contains(serveOpts, flag);
    }
    for (const ex of commands.commands.serve.examples) {
      assert.match(ex, /^oag-mcp serve --spec \S+ --sdk \S+/);
    }
  });
});

describe("cli - documentation", function () {
  it("should not describe the removed build or artifact workflow outside the migration notes", function () {
    const files = [
      "README.md",
      ...fs.readdirSync(path.join(ROOT, "docs")).map((f) => `docs/${f}`),
      ...fs
        .readdirSync(path.join(ROOT, "examples"))
        .map((f) => `examples/${f}`),
      "conf/commands.json",
    ];
    const removed =
      /oag-mcp build|--generate-sdk|--oag-backend|--no-install|oag-mcp-manifest|serve \.\/[\w-]+ --transport|\bartifact director/;
    for (const rel of files) {
      let text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      if (rel === "README.md") {
        // The migration notes name the old commands on purpose.
        text = text.replace(/### Migrating from[\s\S]*?(?=\n## )/, "");
      }
      assert.isFalse(removed.test(text), `${rel}: ${removed.exec(text)?.[0]}`);
    }
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.contains(
      readme,
      "oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio",
    );
    assert.contains(readme, "### Migrating from `oag-mcp build`");
  });
});

describe("semaphore - acquire", function () {
  it("should bound concurrency and queue length", async function () {
    const s = new Semaphore(1, 1);
    const r1 = await s.acquire();
    const pending = s.acquire();
    assert.isUndefined(await s.acquire());
    r1!();
    const r2 = await pending;
    assert.isFunction(r2);
    r2!();
  });
});
