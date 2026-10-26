"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";
import bag from "bagofcli";
import sinon from "sinon";

import cli from "../lib/cli.js";
import { LOG_LEVELS, Logs } from "../lib/logging/logger.js";
import { readLogRecords } from "./helpers/log-records.js";
import { ROOT, SDK_726, SPEC, tmpDir } from "./helpers/paths.js";

const { assert, refute } = referee;

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
      ...fs
        .readdirSync(path.join(ROOT, "docs"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `docs/${f}`),
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

/**
 * The serve action, run against the process as faked here: process.exit
 * is recorded, signal and stdin handlers are captured, stderr is captured.
 */
function harness() {
  const exits: number[] = [];
  const stderr: string[] = [];
  const signals: Record<string, () => void> = {};
  let stdinEnd: (() => void) | undefined;
  let action: ((args: Record<string, unknown>) => void) | undefined;
  sinon.stub(bag, "command").value(function (
    _base: string,
    actions: { commands: { serve: { action: typeof action } } },
  ) {
    action = actions.commands.serve.action;
  });
  cli.exec();
  sinon.stub(process, "exit").callsFake(((code: number) => {
    exits.push(code);
  }) as never);
  const on = process.on.bind(process);
  sinon.stub(process, "on").callsFake(((event: string, fn: () => void) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      signals[event] = fn;
      return process;
    }
    return on(event, fn);
  }) as never);
  sinon.stub(process.stdin, "once").callsFake(((
    event: string,
    fn: () => void,
  ) => {
    if (event === "end") {
      stdinEnd = fn;
    }
    return process.stdin;
  }) as never);
  sinon.stub(process.stderr, "write").callsFake(((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as never);
  const dir = tmpDir();
  const config = path.join(dir, "oag-mcp.yaml");
  fs.writeFileSync(
    config,
    [
      "upstream:",
      "  baseUrl: http://127.0.0.1:9/v1",
      "execution:",
      "  typecheck: false",
      "logging:",
      `  file: ${path.join(dir, "config.log")}`,
      "  level: debug",
    ].join("\n"),
  );
  const logFile = path.join(dir, "cli.log");
  return {
    exits,
    stderr,
    signals,
    stdinEnd: () => stdinEnd,
    records: () => readLogRecords(logFile),
    run(args: Record<string, unknown> = {}) {
      action!({
        spec: SPEC,
        sdk: SDK_726,
        config,
        logFile,
        auditLogFile: logFile,
        ...args,
      });
    },
  };
}

async function until(cond: () => unknown, ms = 30000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("cli - serve", function () {
  this.timeout(60000);

  afterEach(function () {
    sinon.restore();
  });

  it("should serve over HTTP with flag overrides, then stop cleanly on a signal", async function () {
    const h = harness();
    h.run({
      transport: "streamable-http",
      host: "127.0.0.1",
      port: "0",
      path: "/mcp-test",
      logLevel: "info",
      logFormat: "json",
    });
    await until(() => h.stderr.join("").includes("listening on"));
    const url = /listening on (\S+)/.exec(h.stderr.join(""))![1];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp-test$/);
    const health = await fetch(new URL("/healthz", url));
    assert.equals(health.status, 200);
    h.signals.SIGTERM();
    await until(() => h.exits.length > 0);
    assert.equals(h.exits, [0]);
    // A second signal while stopping is ignored.
    h.signals.SIGINT();
    assert.equals(h.exits, [0]);
    const events = h.records().map((r) => r.event);
    assert.contains(events, "cli.command.started");
    assert.contains(events, "server.shutdown_requested");
    assert.contains(events, "cli.command.completed");
    refute.contains(
      events,
      "prepare.stage.started",
      "debug from the config is overridden",
    );
  });

  it("should stop when the MCP client closes stdin", async function () {
    const h = harness();
    h.run({ transport: "stdio" });
    await until(() => h.stdinEnd());
    h.stdinEnd()!();
    await until(() => h.exits.length > 0);
    assert.equals(h.exits, [0]);
    assert.equals(
      h
        .records()
        .find((r) => r.event === "server.shutdown_requested")!
        .get("signal"),
      "stdin_closed",
    );
  });

  it("should cancel start-up on a signal, and exit at once on a second", async function () {
    const h = harness();
    h.run({ transport: "streamable-http", port: "0" });
    h.signals.SIGINT();
    h.signals.SIGINT();
    assert.equals(h.exits, [1], "second signal exits immediately");
    await until(() => h.exits.length > 1);
    assert.equals(h.exits, [1, 1]);
    assert.match(h.stderr.join(""), /Error \[STARTUP_ABORTED\]/);
    const failed = h.records().find((r) => r.event === "cli.command.failed")!;
    assert.equals(failed.get("errorCode"), "STARTUP_ABORTED");
  });

  it("should close a server whose start-up was cancelled while its transport started", async function () {
    const h = harness();
    const op = Logs.prototype.op;
    sinon.stub(Logs.prototype, "op").callsFake(function (
      this: Logs,
      ...args: Parameters<Logs["op"]>
    ) {
      op.apply(this, args);
      if (args[1] === "transport.initialized") {
        h.signals.SIGTERM();
      }
    });
    h.run({ transport: "streamable-http", port: "0" });
    await until(() => h.exits.length > 0);
    // Exits 1 after closing the server (the fake exit returns, so any
    // output after it here is not what a real exit would print).
    assert.equals(h.exits[0], 1);
    assert.contains(
      h.records().map((r) => r.event),
      "server.stopped",
    );
  });

  it("should report a configuration that cannot be read, before logging starts", async function () {
    const h = harness();
    h.run({ config: path.join(tmpDir(), "missing.yaml") });
    await until(() => h.exits.length > 0);
    assert.equals(h.exits, [1]);
    assert.match(h.stderr.join(""), /^Error \[CONFIG_NOT_FOUND\]/);
  });
});
