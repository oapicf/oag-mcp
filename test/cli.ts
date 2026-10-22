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

  it("should contain build and serve commands with actions", function (done) {
    sinon.stub(bag, "command").value(function (
      base: string,
      actions: { commands: Record<string, { action: unknown }> },
    ) {
      assert.isString(base);
      assert.isFunction(actions.commands.build.action);
      assert.isFunction(actions.commands.serve.action);
      done();
    });
    cli.exec();
  });

  it("should define every command in conf/commands.json", function () {
    const commands = JSON.parse(
      fs.readFileSync(path.join(ROOT, "conf", "commands.json"), "utf8"),
    );
    assert.equals(Object.keys(commands.commands).sort(), ["build", "serve"]);
    const buildOpts = commands.commands.build.options.map(
      (o: { arg: string }) => o.arg.split(" ")[0],
    );
    for (const flag of [
      "--spec",
      "--sdk",
      "--generate-sdk",
      "--out",
      "--oag-version",
      "--oag-backend",
    ]) {
      assert.contains(buildOpts, flag);
    }
    const serveOpts = commands.commands.serve.options.map(
      (o: { arg: string }) => o.arg.split(" ")[0],
    );
    for (const flag of ["--transport", "--port", "--config"]) {
      assert.contains(serveOpts, flag);
    }
    for (const ex of [
      ...commands.commands.build.examples,
      ...commands.commands.serve.examples,
    ]) {
      assert.match(ex, /^oag-mcp /);
    }
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
