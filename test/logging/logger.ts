"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tty from "node:tty";

import referee from "@sinonjs/referee";
import sinon from "sinon";

import { Logs, MAX_WRITE_RETRIES } from "../../lib/logging/logger.js";
import { OCSF_VERSION } from "../../lib/logging/ocsf.js";
import { secrets } from "../../lib/util/redact.js";
import { oagMcpVersion } from "../../lib/util/version.js";
import { readLogRecords } from "../helpers/log-records.js";

const { assert, refute, match } = referee;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON
function readJsonLines(file: string): Array<Record<string, any>> {
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

  it("should write OpenTelemetry operational records and OCSF audit records to separate destinations when configured", function () {
    const op = path.join(this.dir, "op.log");
    const audit = path.join(this.dir, "audit.log");
    const logs = new Logs({ file: op, auditFile: audit, instanceId: "inst-1" });
    logs.op("info", "server.ready", { transport: "stdio", methods: 3 });
    logs.audit(
      "authorization.denied",
      "denied",
      {
        operation: "PetsApi.listPets",
        httpMethod: "GET",
        policyId: "p1",
        reason: "default_deny",
      },
      "warn",
    );
    logs.flush();
    const [opRecord, ...moreOp] = readJsonLines(op);
    const [auditRecord, ...moreAudit] = readJsonLines(audit);
    assert.equals(moreOp.length + moreAudit.length, 0);

    // OpenTelemetry Logs Data Model.
    assert.equals(opRecord.SeverityText, "INFO");
    assert.equals(opRecord.SeverityNumber, 9);
    assert.match(opRecord.Timestamp, /^\d{19}$/);
    assert.equals(opRecord.Resource, {
      "service.name": "oag-mcp",
      "service.version": oagMcpVersion(),
      "service.instance.id": "inst-1",
    });
    assert.equals(opRecord.InstrumentationScope, {
      Name: "oag-mcp.operational",
      Version: oagMcpVersion(),
    });
    assert.equals(opRecord.EventName, "server.ready");
    assert.equals(opRecord.Body, "server.ready");
    assert.equals(opRecord.Attributes, {
      "network.transport": "pipe",
      "oag_mcp.methods": 3,
    });

    // OCSF API Activity: Read, denied.
    assert.equals(auditRecord.class_uid, 6003);
    assert.equals(auditRecord.category_uid, 6);
    assert.equals(auditRecord.activity_id, 2);
    assert.equals(auditRecord.type_uid, 600302);
    assert.equals(auditRecord.severity_id, 2);
    assert.equals(auditRecord.status_id, 2);
    assert.equals(auditRecord.status_detail, "default_deny");
    assert.equals(auditRecord.action_id, 2);
    assert.equals(auditRecord.policy, { uid: "p1" });
    assert.equals(auditRecord.api, match({ operation: "PetsApi.listPets" }));
    assert.isNumber(auditRecord.time);
    assert.equals(auditRecord.message, "authorization.denied");
    assert.equals(
      auditRecord.metadata,
      match({
        version: OCSF_VERSION,
        event_code: "authorization.denied",
        product: match({ name: "oag-mcp", version: oagMcpVersion() }),
        reporter: match({ uid: "inst-1" }),
      }),
    );
    assert.isUndefined(auditRecord.level);
  });

  it("should write both categories to one stream when only one destination is given", function () {
    const file = path.join(this.dir, "all.log");
    const logs = new Logs({ file, auditFile: file });
    logs.op("info", "a.event");
    logs.audit("execution.requested", "accepted");
    assert.equals(
      readLogRecords(file).map((r) => r.category),
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
    assert.equals(readLogRecords(audit)[0].event, "authentication.failed");
  });

  it("should carry child context fields into every record", function () {
    const file = path.join(this.dir, "all.log");
    const logs = new Logs({ file, auditFile: file }).child({
      requestId: "req_1",
      executionId: "exec_1",
      principalId: "local:test",
    });
    logs.op("info", "execution.started");
    logs.audit("authorization.allowed", "allowed", { operation: "X.y" });
    for (const r of readLogRecords(file)) {
      assert.equals(r.requestId, "req_1", r.category);
      assert.equals(r.executionId, "exec_1", r.category);
      assert.equals(r.principalId, "local:test", r.category);
    }
  });

  it("should keep fields that neither standard defines, namespaced or unmapped", function () {
    const file = path.join(this.dir, "all.log");
    const logs = new Logs({ file, auditFile: file });
    logs.op("info", "prepare.stage.completed", { stage: "sdk", durationMs: 5 });
    logs.audit("execution.capability_denied", "denied", { capability: "net" });
    const [op, audit] = readJsonLines(file);
    assert.equals(op.Attributes, {
      "oag_mcp.stage": "sdk",
      "oag_mcp.duration_ms": 5,
    });
    assert.equals(audit.unmapped, { capability: "net" });
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
    logs.audit("execution.requested", "accepted", {
      request: { headers: values },
    });
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
      if (busy && fd !== 2 && String(data).includes('"class_uid"')) {
        attempts++;
        throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      }
      return writeSync(fd, data, ...rest);
    }) as typeof fs.writeSync);

    // First record: the first attempt plus MAX_WRITE_RETRIES retries.
    assert.isFalse(logs.audit("execution.requested", "accepted", { n: 1 }));
    assert.equals(attempts, MAX_WRITE_RETRIES + 1);
    assert.isTrue(logs.auditBlocksExecution());

    // While still busy, later records fail fast instead of waiting again.
    attempts = 0;
    const started = performance.now();
    assert.isFalse(logs.audit("execution.requested", "accepted", { n: 2 }));
    assert.equals(attempts, 1);
    assert.less(performance.now() - started, 90);

    // Once the reader drains the pipe, the backlog is written in order.
    busy = false;
    assert.isTrue(logs.audit("execution.requested", "accepted", { n: 3 }));
    assert.equals(
      readLogRecords(file).map((r) => r.get("n")),
      [1, 2, 3],
    );
    // Fail-closed stays in force once an audit record has failed.
    assert.isTrue(logs.auditBlocksExecution());
  });

  it("should not hang when flushing or logging fatal records to a destination that keeps failing", function () {
    // pino flushes the destination after every fatal record; with a
    // persistent error (here EBADF) that must give up, not retry forever.
    const logs = new Logs({ file: "fd:99", auditFile: "fd:98" });
    logs.op("fatal", "test.fatal");
    logs.audit("security.config_invalid", "failure", {}, "error");
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

describe("logger - Logs on stderr", function () {
  let stderr: string[];

  beforeEach(function () {
    stderr = [];
    // Pretty output is colourised only on a TTY; pin it off so the
    // assertions hold whether or not the tests run in a terminal.
    sinon.stub(tty, "isatty").returns(false);
    const writeSync = fs.writeSync;
    sinon.stub(fs, "writeSync").callsFake(((
      fd: number,
      data: string | Buffer,
      ...rest: never[]
    ) => {
      if (fd === 2) {
        stderr.push(String(data));
        return Buffer.byteLength(String(data));
      }
      return writeSync(fd, data as string, ...rest);
    }) as typeof fs.writeSync);
  });

  afterEach(function () {
    sinon.restore();
  });

  async function settle() {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it("should print one readable line per record in pretty format", async function () {
    const logs = new Logs({ format: "pretty", level: "debug" });
    logs.op("info", "tools.registered", { outcome: "success" });
    logs.op("info", "server.ready");
    logs.audit(
      "authentication.failed",
      "failure",
      { mode: "static-bearer", reason: "missing_token" },
      "warn",
    );
    logs.audit("authentication.succeeded", "success", { mode: "none" });
    logs.flush();
    await settle();
    const text = stderr.join("");
    assert.match(text, /\[operational\] tools\.registered success/);
    assert.match(
      text,
      /\[operational\] server\.ready\n|\[operational\] server\.ready\s/,
    );
    assert.match(
      text,
      /\[security_audit\] authentication\.failed Authentication: \S.*\(missing_token\)/,
    );
    assert.match(text, /\[security_audit\] authentication\.succeeded /);
  });

  it("should report an operational file it cannot open on stderr", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-logs-"));
    try {
      new Logs({ file: path.join(dir, "missing-dir", "op.log") });
      assert.match(stderr.join(""), /logging\.destination_open_failed/);
      assert.match(stderr.join(""), /operational/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("logger - Logs.ctx", function () {
  it("should expose a copy of a child's context", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-logs-"));
    try {
      const logs = new Logs({ file: path.join(dir, "all.log") });
      const child = logs
        .child({ requestId: "req_1" })
        .child({ executionId: "e" });
      assert.equals(child.ctx, { requestId: "req_1", executionId: "e" });
      const ctx = child.ctx;
      ctx.requestId = "changed";
      assert.equals(child.ctx.requestId, "req_1");
      assert.equals(logs.ctx, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
