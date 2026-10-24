"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import bag from "bagofcli";
import sinon from "sinon";

import cli from "../lib/cli.js";
import { LOG_LEVELS } from "../lib/logger.js";
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
    assert.isUndefined(commands.commands.serve.args);
    for (const flag of ["--spec", "--sdk"]) {
      const opt = commands.commands.serve.options.find((o: { arg: string }) =>
        o.arg.startsWith(`${flag} `),
      );
      assert.equals(opt.rules, ["required"], flag);
    }
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

  it("should declare argument validation for bagofcli in conf/commands.json", function () {
    const commands = JSON.parse(
      fs.readFileSync(path.join(ROOT, "conf", "commands.json"), "utf8"),
    );
    type Opt = { arg: string; [k: string]: unknown };
    const find = (opts: Opt[], flag: string) =>
      opts.find((o) => o.arg.startsWith(`${flag} `))!;
    const serve = commands.commands.serve;
    assert.isFalse(serve.allowExcessArguments);
    assert.equals(find(serve.options, "--sdk-layout").choices, [
      "auto",
      "source",
      "compiled",
    ]);
    assert.equals(find(serve.options, "--transport").choices, [
      "stdio",
      "streamable-http",
    ]);
    const port = find(serve.options, "--port");
    assert.equals([port.integer, port.min, port.max], [true, 0, 65535]);
    // The allowed log levels must stay in step with the logger.
    assert.equals(find(commands.options, "--log-level").choices, [
      ...LOG_LEVELS,
    ]);
    assert.equals(find(commands.options, "--log-format").choices, [
      "json",
      "pretty",
    ]);
  });
});

describe("cli - documentation", function () {
  it("should document only serve invocations that pass --spec and --sdk", function () {
    const files = [
      "README.md",
      ...fs.readdirSync(path.join(ROOT, "docs")).map((f) => `docs/${f}`),
      ...fs
        .readdirSync(path.join(ROOT, "examples"))
        .map((f) => `examples/${f}`),
    ];
    let invocations = 0;
    for (const rel of files) {
      const text = fs
        .readFileSync(path.join(ROOT, rel), "utf8")
        .replace(/\\\n\s*/g, " ");
      // Every documented invocation with options must name both inputs.
      for (const m of text.matchAll(/oag-mcp serve (?!--help)--[^\n`|]*/g)) {
        assert.match(m[0], /--spec\b/, `${rel}: ${m[0]}`);
        assert.match(m[0], /--sdk\b/, `${rel}: ${m[0]}`);
        invocations++;
      }
    }
    assert(invocations >= 10, `only ${invocations} invocations found`);
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.contains(
      readme,
      "oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk --transport stdio",
    );
  });
});
