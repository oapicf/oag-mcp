"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import referee from "@sinonjs/referee";
import sinon from "sinon";

import { Logs, MAX_WRITE_RETRIES } from "../../lib/logging/logger.js";
import { secrets } from "../../lib/logging/redact.js";

const { assert, refute } = referee;

function readJsonLines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("logger - Logs", function () {
  beforeEach(function () {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-logs-"));
  });

  afterEach(function () {
    sinon.restore();
    fs.rmSync(this.dir, { recursive: true, force: true });
  });

  it("should route operational and audit records to separate destinations when configured", function () {
    const op = path.join(this.dir, "op.log");
    const audit = path.join(this.dir, "audit.log");
    const logs = new Logs({ file: op, auditFile: audit, instanceId: "inst-1" });
    logs.op("info", "server.ready", { transport: "stdio" });
    logs.audit(
      "authorization.denied",
      "denied",
      { operation: "PetsApi.listPets", policyId: "p1" },
      "warn",
    );
    logs.flush();
    const opRecords = readJsonLines(op);
    const auditRecords = readJsonLines(audit);
    assert.equals(opRecords.length, 1);
    assert.equals(auditRecords.length, 1);
    assert.equals(opRecords[0].logCategory, "operational");
    assert.equals(opRecords[0].event, "server.ready");
    assert.equals(auditRecords[0].logCategory, "security_audit");
    assert.equals(auditRecords[0].event, "authorization.denied");
    assert.equals(auditRecords[0].outcome, "denied");
    for (const r of [...opRecords, ...auditRecords]) {
      assert.equals(r.service, "oag-mcp");
      assert.equals(r.instanceId, "inst-1");
      assert.isString(r.time);
      assert.isString(r.level);
      assert.isString(r.severity);
      assert.isString(r.version);
    }
  });

  it("should write both categories to one stream when only one destination is given", function () {
    const file = path.join(this.dir, "all.log");
    const logs = new Logs({ file, auditFile: file });
    logs.op("info", "a.event");
    logs.audit("b.event", "success");
    const records = readJsonLines(file);
    assert.equals(
      records.map((r) => r.logCategory),
      ["operational", "security_audit"],
    );
  });

  it("should keep audit records when the operational level suppresses everything", function () {
    const op = path.join(this.dir, "op.log");
    const audit = path.join(this.dir, "audit.log");
    const logs = new Logs({ level: "silent", file: op, auditFile: audit });
    logs.op("error", "should.not.appear");
    logs.audit("authentication.failed", "failure", { reason: "invalid_token" });
    assert.equals(fs.existsSync(op) ? fs.readFileSync(op, "utf8") : "", "");
    assert.equals(readJsonLines(audit)[0].event, "authentication.failed");
  });

  it("should carry child context fields into every record", function () {
    const file = path.join(this.dir, "all.log");
    const logs = new Logs({ file, auditFile: file }).child({
      requestId: "req_1",
      executionId: "exec_1",
    });
    logs.audit("authorization.allowed", "allowed", { operation: "X.y" });
    const [r] = readJsonLines(file);
    assert.equals(r.requestId, "req_1");
    assert.equals(r.executionId, "exec_1");
  });

  it("should redact registered secrets and sensitive keys from records", function () {
    const file = path.join(this.dir, "all.log");
    secrets.add("logger-test-secret-value");
    const logs = new Logs({ file, auditFile: file });
    logs.op("info", "test.event", {
      note: "contains logger-test-secret-value",
      headers: { authorization: "Bearer logger-test-secret-value" },
      url: "https://x.test/?api_key=abc12345",
    });
    const text = fs.readFileSync(file, "utf8");
    refute.contains(text, "logger-test-secret-value");
    refute.contains(text, "abc12345");
  });

  it("should censor credential keys at any depth and in any case when values are not registered", function () {
    const file = path.join(this.dir, "keys.log");
    const logs = new Logs({ file, auditFile: file });
    const keys = [
      "authorization",
      "Authorization",
      "cookie",
      "password",
      "token",
      "accessToken",
      "access_token",
      "refresh_token",
      "clientSecret",
      "client_secret",
      "apiKey",
      "X-Api-Key",
    ];
    const values = Object.fromEntries(keys.map((k) => [k, `plain-${k}-value`]));
    logs.op("info", "test.keys", {
      ...values,
      headers: { ...values },
      deep: { a: { b: { ...values } } },
    });
    logs.audit("test.keys", "success", { request: { headers: values } });
    const text = fs.readFileSync(file, "utf8");
    for (const k of keys) {
      refute.contains(text, `plain-${k}-value`, k);
    }
    assert.contains(text, "[REDACTED]");
  });

  it("should report audit destination failure and block execution when fail-closed", function () {
    const logs = new Logs({
      file: path.join(this.dir, "op.log"),
      auditFile: "fd:99",
      auditFailClosed: true,
    });
    const ok = logs.audit("execution.requested", "accepted");
    assert.isFalse(ok);
    assert.isFalse(logs.auditHealthy);
    assert.isTrue(logs.auditBlocksExecution());
  });

  it("should not block execution on audit failure when fail-closed is off", function () {
    const logs = new Logs({
      file: path.join(this.dir, "op.log"),
      auditFile: "fd:99",
    });
    logs.audit("execution.requested", "accepted");
    assert.isFalse(logs.auditHealthy);
    assert.isFalse(logs.auditBlocksExecution());
  });

  it("should retry a full non-blocking destination a bounded number of times, then fail fast, and write the backlog once it drains", function () {
    // sonic-boom waits 100 ms between retries, so the first record takes ~2 s.
    this.timeout(15000);
    const file = path.join(this.dir, "audit.log");
    const logs = new Logs({
      file: path.join(this.dir, "op.log"),
      auditFile: file,
      auditFailClosed: true,
    });
    // Simulate a full non-blocking pipe for audit writes: every attempt fails
    // with EAGAIN until the reader "drains" it.
    const writeSync = fs.writeSync;
    let busy = true;
    let attempts = 0;
    sinon.stub(fs, "writeSync").callsFake(((
      fd: number,
      data: string,
      ...rest: never[]
    ) => {
      if (busy && fd !== 2 && String(data).includes("security_audit")) {
        attempts++;
        throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      }
      return writeSync(fd, data, ...rest);
    }) as typeof fs.writeSync);

    // First record: the first attempt plus MAX_WRITE_RETRIES retries.
    assert.isFalse(logs.audit("test.first", "success"));
    assert.equals(attempts, MAX_WRITE_RETRIES + 1);
    assert.isTrue(logs.auditBlocksExecution());

    // While still busy, later records fail fast instead of waiting again.
    attempts = 0;
    const started = performance.now();
    assert.isFalse(logs.audit("test.second", "success"));
    assert.equals(attempts, 1);
    assert.less(performance.now() - started, 90);

    // Once the reader drains the pipe, the backlog is written in order.
    busy = false;
    assert.isTrue(logs.audit("test.third", "success"));
    assert.equals(
      readJsonLines(file).map((r) => r.event),
      ["test.first", "test.second", "test.third"],
    );
    // Fail-closed stays in force once an audit record has failed.
    assert.isTrue(logs.auditBlocksExecution());
  });

  it("should not hang when flushing or logging fatal records to a destination that keeps failing", function () {
    // pino flushes the destination after every fatal record; with a
    // persistent error (here EBADF) that must give up, not retry forever.
    const logs = new Logs({ file: "fd:99", auditFile: "fd:98" });
    logs.op("fatal", "test.fatal");
    logs.audit("test.audit", "failure", {}, "error");
    logs.flush();
    assert.isFalse(logs.auditHealthy);
  });

  it("should count write failures in pretty format for fail-closed auditing", function () {
    const logs = new Logs({ format: "pretty", auditFailClosed: true });
    const writeSync = fs.writeSync;
    sinon.stub(fs, "writeSync").callsFake(((
      fd: number,
      data: string,
      ...rest: never[]
    ) => {
      if (fd === 2) {
        throw Object.assign(new Error("stderr gone"), { code: "EIO" });
      }
      return writeSync(fd, data, ...rest);
    }) as typeof fs.writeSync);
    assert.isFalse(logs.audit("execution.requested", "accepted"));
    assert.isTrue(logs.auditBlocksExecution());
  });

  it("should treat an unopenable audit file as a failure", function () {
    const logs = new Logs({
      auditFile: path.join(this.dir, "missing-dir", "audit.log"),
      auditFailClosed: true,
    });
    assert.isTrue(logs.auditBlocksExecution());
  });

  it("should refuse stdout as a destination", function () {
    assert.exception(() => new Logs({ file: "stdout" }), {
      message: /stdout is reserved/,
    });
    assert.exception(() => new Logs({ auditFile: "fd:1" }), {
      message: /stdout/,
    });
  });
});
