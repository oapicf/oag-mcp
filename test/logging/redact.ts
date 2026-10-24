"use strict";
import referee from "@sinonjs/referee";

import {
  REDACTED,
  SecretRegistry,
  boundValue,
  isSensitiveKey,
  sanitizeError,
} from "../../lib/logging/redact.js";

const { assert, refute } = referee;

describe("redact - SecretRegistry.scrub", function () {
  it("should replace registered secrets and their base64 form when present in text", function () {
    const reg = new SecretRegistry();
    reg.add("super-secret-value");
    const b64 = Buffer.from("super-secret-value").toString("base64");
    const out = reg.scrub(`a super-secret-value b ${b64}`);
    refute.contains(out, "super-secret-value");
    refute.contains(out, b64);
    assert.contains(out, REDACTED);
  });

  it("should ignore very short values when registering", function () {
    const reg = new SecretRegistry();
    reg.add("abc");
    assert.equals(reg.size, 0);
    assert.equals(reg.scrub("abc"), "abc");
  });

  it("should scrub bearer tokens, JWTs and credential query parameters when not registered", function () {
    const reg = new SecretRegistry();
    const text =
      "Authorization: Bearer abcdef123456 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig and https://api.test/x?api_key=k1234&ok=1";
    const out = reg.scrub(text);
    refute.contains(out, "abcdef123456");
    refute.contains(out, "eyJzdWIiOiIxIn0");
    refute.contains(out, "k1234");
    assert.contains(out, "ok=1");
  });

  it("should only replace registered values when using scrubKnown", function () {
    const reg = new SecretRegistry();
    reg.add("token-1234567");
    assert.equals(
      reg.scrubKnown("Bearer xyz token-1234567"),
      `Bearer xyz ${REDACTED}`,
    );
  });

  it("should stop scrubbing a value after it is removed", function () {
    const reg = new SecretRegistry();
    reg.add("rotating-token-1");
    reg.remove("rotating-token-1");
    assert.equals(reg.scrubKnown("rotating-token-1"), "rotating-token-1");
  });
});

describe("redact - boundValue", function () {
  it("should censor sensitive keys at any depth", function () {
    const out = boundValue({
      a: { Authorization: "Bearer x", nested: { client_secret: "y", ok: 1 } },
    }) as Record<string, Record<string, Record<string, unknown>>>;
    assert.equals(out.a.Authorization, REDACTED);
    assert.equals(out.a.nested.client_secret, REDACTED);
    assert.equals(out.a.nested.ok, 1);
  });

  it("should truncate long strings and cap arrays and depth", function () {
    const out = boundValue(
      {
        s: "x".repeat(1000),
        arr: Array.from({ length: 60 }, (_, i) => i),
        deep: { a: { b: { c: { d: 1 } } } },
      },
      { maxString: 10, maxArray: 5, maxDepth: 3 },
    ) as { s: string; arr: unknown[]; deep: { a: { b: unknown } } };
    assert.match(out.s, /^x{10}…\[truncated 990\]$/);
    assert.equals(out.arr.length, 6);
    assert.equals(out.deep.a.b, "[max-depth]");
  });

  it("should mark circular references", function () {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = boundValue(a) as Record<string, unknown>;
    assert.equals(out.self, "[circular]");
  });
});

describe("redact - isSensitiveKey", function () {
  it("should recognise credential key names case-insensitively", function () {
    for (const k of [
      "authorization",
      "Cookie",
      "password",
      "apiKey",
      "x-api-key",
      "client_secret",
      "refresh_token",
    ]) {
      assert.isTrue(isSensitiveKey(k), k);
    }
    refute(isSensitiveKey("operation"));
  });
});

describe("redact - sanitizeError", function () {
  it("should keep name and code but scrub the message", function () {
    const reg = new SecretRegistry();
    reg.add("leaky-secret-99");
    const err = Object.assign(new Error("failed with leaky-secret-99"), {
      code: "E_X",
    });
    const out = sanitizeError(err, reg);
    assert.equals(out.name, "Error");
    assert.equals(out.code, "E_X");
    refute.contains(out.message, "leaky-secret-99");
  });
});
