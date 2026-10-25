"use strict";
import referee from "@sinonjs/referee";
import sinon from "sinon";

import type { Principal } from "../../lib/types.js";
import { SecretResolver } from "../../lib/util/secrets.js";
import { OagMcpError } from "../../lib/errors.js";
import { SecretRegistry } from "../../lib/util/redact.js";
import {
  ServiceIdentityCredentialProvider,
  UpstreamAuthError,
} from "../../lib/upstream/credentials.js";
import { resolveSecurity } from "../../lib/upstream/security.js";
import { SCHEMES, fakeFetch, quietLogs } from "../helpers/fakes.js";

const { assert, match } = referee;

const principal: Principal = { id: "local:test", kind: "local", scopes: [] };
const env = {
  KEY: "key-value-123456",
  TOKEN: "bearer-value-123456",
  USER: "admin",
  PASS: "pass-value-123456",
  CID: "client-id-1",
  CSEC: "client-secret-123456",
};

function provider(
  schemes: Record<string, unknown>,
  fetchImpl?: typeof fetch,
  opts: { allowInsecureTokenUrl?: boolean } = {},
) {
  const { logs, records } = quietLogs();
  const registry = new SecretRegistry();
  const p = new ServiceIdentityCredentialProvider({
    schemes: schemes as never,
    schemeInfo: SCHEMES,
    resolver: new SecretResolver({ baseDir: process.cwd(), env }),
    registry,
    logs,
    allowInsecureTokenUrl: opts.allowInsecureTokenUrl ?? true,
    baseUrl: "http://127.0.0.1:4010/v1",
    fetchImpl,
  });
  return { p, logs, records, registry };
}

function oauthProvider(
  config: Record<string, unknown>,
  fetchImpl: typeof fetch,
) {
  return provider(
    {
      clinicOAuth: {
        clientId: { env: "CID" },
        clientSecret: { env: "CSEC" },
        ...config,
      },
    },
    fetchImpl,
  );
}

function tokenFetch(json: Record<string, unknown>) {
  return fakeFetch(() => new Response(JSON.stringify(json), { status: 200 }));
}

const ctx = (logs: ReturnType<typeof quietLogs>["logs"]) => ({
  principal,
  operation: {
    id: "PetsApi.createPet",
    className: "PetsApi",
    methodName: "createPet",
    httpMethod: "POST",
    path: "/pets",
    tags: [],
    security: [],
  },
  logs,
});

describe("credentials - ServiceIdentityCredentialProvider", function () {
  it("should apply apiKey header/query, basic and bearer credentials", async function () {
    const { p, logs, registry } = provider({
      apiKeyHeader: { apiKey: { env: "KEY" } },
      apiKeyQuery: { apiKey: { env: "KEY" } },
      adminBasic: { username: { env: "USER" }, password: { env: "PASS" } },
      bearerAuth: { token: { env: "TOKEN" } },
    });
    assert.equals(
      (await p.apply(SCHEMES.apiKeyHeader, [], ctx(logs))).headers,
      { "X-Api-Key": env.KEY },
    );
    assert.equals((await p.apply(SCHEMES.apiKeyQuery, [], ctx(logs))).query, {
      api_key: env.KEY,
    });
    assert.equals(
      (await p.apply(SCHEMES.adminBasic, [], ctx(logs))).headers.Authorization,
      `Basic ${Buffer.from("admin:pass-value-123456").toString("base64")}`,
    );
    assert.equals(
      (await p.apply(SCHEMES.bearerAuth, [], ctx(logs))).headers.Authorization,
      `Bearer ${env.TOKEN}`,
    );
    assert.equals(
      registry.scrubKnown(`x ${env.PASS} ${env.TOKEN}`),
      "x [REDACTED] [REDACTED]",
    );
  });

  it("should reject configuration for unknown, unsupported or incomplete schemes at startup", function () {
    for (const cfg of [
      { nope: { apiKey: { env: "KEY" } } },
      { oidc: { token: { env: "TOKEN" } } },
      { adminBasic: { username: { env: "USER" } } },
      { bearerAuth: { token: { env: "MISSING_ENV" } } },
      { apiKeyHeader: { apiKey: "plain-text-key" } },
      { apiKeyHeader: { apiKey: [{ env: "KEY" }] } },
    ]) {
      try {
        provider(cfg);
        assert(false, JSON.stringify(cfg));
      } catch (e) {
        assert.equals((e as OagMcpError).code, "UPSTREAM_AUTH_CONFIG_INVALID");
      }
    }
  });

  it("should reject a non-HTTPS token URL unless explicitly allowed", function () {
    const schemeInfo = { ...SCHEMES };
    try {
      const { logs } = quietLogs();
      new ServiceIdentityCredentialProvider({
        schemes: {
          clinicOAuth: {
            clientId: { env: "CID" },
            clientSecret: { env: "CSEC" },
            tokenUrl: "http://auth.example.test/token",
          },
        },
        schemeInfo,
        resolver: new SecretResolver({ baseDir: process.cwd(), env }),
        registry: new SecretRegistry(),
        logs,
        allowInsecureTokenUrl: false,
        baseUrl: "https://api.example.test",
      });
      assert(false, "expected failure");
    } catch (e) {
      assert.match((e as Error).message, /not HTTPS/);
    }
  });

  it("should cache client credentials tokens, renew after expiry and de-duplicate refreshes", async function () {
    let issued = 0;
    const fetchImpl = fakeFetch(async (_url, init) => {
      issued++;
      const body = new URLSearchParams(String(init.body));
      assert.equals(body.get("grant_type"), "client_credentials");
      assert.equals(body.get("scope"), "pets:write");
      assert.equals(
        (init.headers as Record<string, string>).authorization,
        `Basic ${Buffer.from("client-id-1:client-secret-123456").toString("base64")}`,
      );
      return new Response(
        JSON.stringify({
          access_token: `tok-${issued}-abcdef`,
          token_type: "Bearer",
          expires_in: 31,
        }),
        { status: 200 },
      );
    });
    const { p, logs, records } = provider(
      {
        clinicOAuth: {
          clientId: { env: "CID" },
          clientSecret: { env: "CSEC" },
        },
      },
      fetchImpl,
    );
    const [a, b] = await Promise.all([
      p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs)),
      p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs)),
    ]);
    assert.equals(issued, 1);
    assert.equals(a.headers.Authorization, "Bearer tok-1-abcdef");
    assert.equals(b.headers.Authorization, "Bearer tok-1-abcdef");
    // expires_in 31 with a 30s skew: the next call refreshes after one second.
    await new Promise((r) => setTimeout(r, 1100));
    const c = await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
    assert.equals(c.headers.Authorization, "Bearer tok-2-abcdef");
    assert.equals(issued, 2);
    p.invalidate("clinicOAuth", ctx(logs));
    await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
    assert.equals(issued, 3);
    const events = records().map((r) => r.event);
    assert.contains(events, "upstream.token.issue");
    assert.contains(events, "upstream.token.refresh");
    assert.contains(events, "upstream.token.invalidated");
    // Token values never reach the logs.
    assert.equals(JSON.stringify(records()).includes("tok-1-abcdef"), false);
  });

  it("should raise a clear error when the token endpoint rejects the client", async function () {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
        }),
    );
    const { p, logs, records } = provider(
      {
        clinicOAuth: {
          clientId: { env: "CID" },
          clientSecret: { env: "CSEC" },
        },
      },
      fetchImpl,
    );
    try {
      await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
      assert(false, "expected failure");
    } catch (e) {
      assert(e instanceof UpstreamAuthError);
      assert.equals((e as UpstreamAuthError).reason, "token_request_failed");
    }
    assert.contains(
      records().map((r) => r.event),
      "upstream.token.issue_failed",
    );
  });

  it("should refuse a scheme it has no credentials for", async function () {
    const { p, logs } = provider({ bearerAuth: { token: { env: "TOKEN" } } });
    assert.isFalse(p.has("apiKeyHeader"));
    await assert.rejects(
      p.apply(SCHEMES.apiKeyHeader, [], ctx(logs)),
      match({ reason: "credential_not_configured" }),
    );
  });

  it("should reuse a cached token until shortly before it expires", async function () {
    const fetchImpl = tokenFetch({
      access_token: "tok-long",
      expires_in: 3600,
    });
    const { p, logs, records } = oauthProvider({}, fetchImpl);
    await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
    const again = await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
    assert.equals(again.headers.Authorization, "Bearer tok-long");
    assert.equals(fetchImpl.calls.length, 1);
    assert.contains(
      records().map((r) => r.event),
      "upstream.token.cache_hit",
    );
  });

  it("should post client credentials, configured scopes and the audience in the form", async function () {
    const fetchImpl = tokenFetch({ access_token: "tok-post" });
    const { p, logs, records } = oauthProvider(
      {
        clientAuthMethod: "client_secret_post",
        audience: "https://api.example.test",
        scopes: ["b", "a"],
      },
      fetchImpl,
    );
    await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
    const { url, init } = fetchImpl.calls[0];
    assert.equals(url.toString(), "http://127.0.0.1:4011/token");
    assert.equals(init.redirect, "error");
    assert.isUndefined((init.headers as Record<string, string>).authorization);
    assert.equals(Object.fromEntries(new URLSearchParams(String(init.body))), {
      grant_type: "client_credentials",
      scope: "b a",
      audience: "https://api.example.test",
      client_id: env.CID,
      client_secret: env.CSEC,
    });
    const issued = records().find((r) => r.event === "upstream.token.issue")!;
    assert.equals(issued.get("expiresInSec"), 300);
    assert.equals(issued.get("scopeCount"), 2);
  });

  it("should leave out the scope when no scopes are needed", async function () {
    const fetchImpl = tokenFetch({ access_token: "tok-x", expires_in: -5 });
    const { p, logs, records } = oauthProvider({ scopes: [] }, fetchImpl);
    await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
    const body = new URLSearchParams(String(fetchImpl.calls[0].init.body));
    assert.isFalse(body.has("scope"));
    assert.equals(
      records()
        .find((r) => r.event === "upstream.token.issue")!
        .get("expiresInSec"),
      300,
    );
  });

  it("should fail clearly when the token endpoint is unreachable", async function () {
    const fetchImpl = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { p, logs, records } = oauthProvider({}, fetchImpl);
    await assert.rejects(
      p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs)),
      match({ reason: "token_endpoint_unreachable" }),
    );
    const failed = records().find(
      (r) => r.event === "upstream.token.issue_failed",
    )!;
    assert.equals(failed.get("reason"), "token_endpoint_unreachable");
    assert.equals(failed.get("error"), "TypeError");
  });

  it("should name why a token response is unusable", async function () {
    const cases: Array<[number, string, string, string | null]> = [
      [200, "not json", "no_access_token", null],
      [200, "null", "no_access_token", null],
      [200, "[1]", "no_access_token", null],
      [200, '{"access_token":7}', "no_access_token", null],
      [
        200,
        '{"access_token":"t","token_type":"mac"}',
        "unsupported_token_type",
        null,
      ],
      [500, '{"error":42}', "token_endpoint_error", null],
      [
        400,
        JSON.stringify({ error: "x".repeat(100) }),
        "token_endpoint_error",
        "x".repeat(64),
      ],
    ];
    for (const [status, body, reason, oauthError] of cases) {
      const fetchImpl = fakeFetch(() => new Response(body, { status }));
      const { p, logs, records } = oauthProvider({}, fetchImpl);
      await assert.rejects(
        p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs)),
        match({ reason: "token_request_failed" }),
      );
      const failed = records().find(
        (r) => r.event === "upstream.token.issue_failed",
      )!;
      assert.equals(failed.get("reason"), reason, body);
      // The token endpoint's HTTP status is the OCSF status_code.
      assert.equals(failed.raw.status_code, String(status), body);
      assert.equals(failed.get("oauthError") ?? null, oauthError, body);
    }
  });

  it("should keep scrubbing a replaced token for a minute", async function () {
    const clock = sinon.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      let issued = 0;
      const fetchImpl = fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              access_token: `tok-${++issued}-abcdef`,
              expires_in: 1,
            }),
          ),
      );
      const { p, logs, registry } = oauthProvider({}, fetchImpl);
      await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
      // expires_in 1 is inside the refresh skew, so the next call refreshes.
      await p.apply(SCHEMES.clinicOAuth, ["pets:write"], ctx(logs));
      assert.equals(issued, 2);
      assert.equals(registry.scrubKnown("tok-1-abcdef"), "[REDACTED]");
      clock.tick(60000);
      assert.equals(registry.scrubKnown("tok-1-abcdef"), "tok-1-abcdef");
      assert.equals(registry.scrubKnown("tok-2-abcdef"), "[REDACTED]");
    } finally {
      clock.restore();
    }
  });

  it("should not report an invalidation when nothing was cached", function () {
    const { p, logs, records } = oauthProvider({}, tokenFetch({}));
    p.invalidate("clinicOAuth", ctx(logs));
    assert.equals(
      records().filter((r) => r.event === "upstream.token.invalidated"),
      [],
    );
  });
});

describe("security - resolveSecurity", function () {
  it("should use the first configured alternative in document order", async function () {
    const { p, logs } = provider({ bearerAuth: { token: { env: "TOKEN" } } });
    const r = await resolveSecurity(
      [{ apiKeyHeader: [] }, { bearerAuth: [] }],
      SCHEMES,
      p,
      ctx(logs),
    );
    assert.equals(r.schemes, ["bearerAuth"]);
    assert.equals(r.alternative, 1);
  });

  it("should require all schemes of an AND alternative", async function () {
    const { p, logs } = provider({
      apiKeyHeader: { apiKey: { env: "KEY" } },
      bearerAuth: { token: { env: "TOKEN" } },
    });
    const r = await resolveSecurity(
      [{ apiKeyHeader: [], bearerAuth: [] }],
      SCHEMES,
      p,
      ctx(logs),
    );
    assert.equals(r.schemes, ["apiKeyHeader", "bearerAuth"]);
    assert.equals(r.headers["X-Api-Key"], env.KEY);
    assert.equals(r.headers.Authorization, `Bearer ${env.TOKEN}`);
  });

  it("should not downgrade to unauthenticated access when credentials are missing", async function () {
    const { p, logs } = provider({});
    try {
      await resolveSecurity(
        [{ apiKeyHeader: [] }, { bearerAuth: [] }],
        SCHEMES,
        p,
        ctx(logs),
      );
      assert(false, "expected failure");
    } catch (e) {
      assert.equals(
        (e as UpstreamAuthError).reason,
        "credential_not_configured",
      );
    }
  });

  it("should allow unauthenticated calls only when the spec allows them", async function () {
    const { p, logs } = provider({});
    assert.equals(
      (await resolveSecurity([], SCHEMES, p, ctx(logs))).schemes,
      [],
    );
    assert.equals(
      (await resolveSecurity([{ bearerAuth: [] }, {}], SCHEMES, p, ctx(logs)))
        .schemes,
      [],
    );
  });

  it("should prefer an authenticated alternative over an optional empty one", async function () {
    const { p, logs } = provider({ bearerAuth: { token: { env: "TOKEN" } } });
    const r = await resolveSecurity(
      [{}, { bearerAuth: [] }],
      SCHEMES,
      p,
      ctx(logs),
    );
    assert.equals(r.schemes, ["bearerAuth"]);
  });

  it("should report unsupported schemes distinctly", async function () {
    const { p, logs } = provider({});
    try {
      await resolveSecurity([{ oidc: [] }], SCHEMES, p, ctx(logs));
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as UpstreamAuthError).reason, "unsupported_scheme");
    }
  });
});
