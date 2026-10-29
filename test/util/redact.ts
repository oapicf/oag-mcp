"use strict";
import referee from "@sinonjs/referee";

import {
  REDACTED,
  SecretRegistry,
  boundValue,
  isSensitiveKey,
  sanitizeError,
} from "../../lib/util/redact.js";

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

  it("should scrub credentials after an authentication scheme in any letter case", function () {
    const reg = new SecretRegistry();
    for (const [text, value] of [
      ["Authorization: Bearer abcdef123456", "abcdef123456"],
      ["authorization: bearer tok_9f8a7b", "tok_9f8a7b"],
      ["Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["BASIC YWRtaW46c2VjcmV0", "YWRtaW46c2VjcmV0"],
      ["Bearer opaqueaccesstokenvalue", "opaqueaccesstokenvalue"],
      ["Digest username=alice", "username=alice"],
    ]) {
      const out = reg.scrub(text);
      refute.contains(out, value, text);
      assert.contains(out, REDACTED, text);
    }
  });

  it("should leave prose that mentions an authentication scheme intact", function () {
    const reg = new SecretRegistry();
    for (const text of [
      "static bearer does not implement MCP OAuth discovery",
      "Bearer token required",
      "use Basic authentication for the admin API",
      "the API accepts basic HTTP credentials",
      "Digest Auth is not supported",
    ]) {
      assert.equals(reg.scrub(text), text);
    }
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

describe("redact - boundValue value kinds", function () {
  it("should keep null, undefined, numbers and booleans, and stringify bigints", function () {
    assert.equals(
      boundValue({ a: null, b: undefined, c: 1.5, d: false, e: 12n }),
      { a: null, b: undefined, c: 1.5, d: false, e: "12" },
    );
    assert.isNull(boundValue(null));
  });

  it("should name functions and symbols instead of copying them", function () {
    assert.equals(boundValue({ f: () => 1, s: Symbol("x") }), {
      f: "[function]",
      s: "[symbol]",
    });
  });

  it("should sanitise errors and write dates as ISO 8601", function () {
    const reg = new SecretRegistry();
    reg.add("error-secret-value");
    const out = boundValue(
      {
        err: new TypeError("failed with error-secret-value"),
        at: new Date(Date.UTC(2026, 0, 31, 12)),
      },
      { registry: reg },
    ) as { err: { name: string; message: string }; at: string };
    assert.equals(out.err.name, "TypeError");
    refute.contains(out.err.message, "error-secret-value");
    assert.equals(out.at, "2026-01-31T12:00:00.000Z");
  });

  it("should keep only the first keys of a large object", function () {
    const big = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`k${i}`, i]),
    );
    assert.equals(boundValue(big, { maxKeys: 3 }), {
      k0: 0,
      k1: 1,
      k2: 2,
      "…": "[more keys truncated]",
    });
  });
});
