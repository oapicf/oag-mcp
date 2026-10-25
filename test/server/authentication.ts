"use strict";
import referee from "@sinonjs/referee";
import * as jose from "jose";
import sinon from "sinon";

import { type Config, parseConfig } from "../../lib/config.js";
import {
  type HttpAuthenticator,
  createHttpAuthenticator,
  isLoopbackHost,
  scopesFromClaims,
} from "../../lib/server/authentication.js";
import { opaquePrincipalId } from "../../lib/server/authorization.js";
import { SecretRegistry } from "../../lib/util/redact.js";
import { SecretResolver } from "../../lib/util/secrets.js";
import { quietLogs } from "../helpers/fakes.js";

const { assert, match } = referee;

const ISSUER = "https://auth.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const JWKS_URI = `${ISSUER}/jwks`;
const INTROSPECT = `${ISSUER}/introspect`;
const env = {
  ALICE: "alice-token-0123456789",
  BOB: "bob-token-0123456789",
  WEAK: "short",
  ICID: "mcp server",
  ISEC: "introspect-secret-123",
};

type Route = (init: RequestInit) => Response | Promise<Response>;

/** Answer fetches by URL; anything else is a network failure. */
function serve(routes: Record<string, Route>) {
  return sinon
    .stub(globalThis, "fetch")
    .callsFake(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const route = routes[url];
      if (!route) {
        throw new TypeError(`fetch failed: ${url}`);
      }
      return route(init ?? {});
    });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function setup(mcpAuth: unknown) {
  const { logs, records } = quietLogs();
  const registry = new SecretRegistry();
  const config: Config = parseConfig({ mcpAuth });
  const auth = await createHttpAuthenticator({
    config,
    resolver: new SecretResolver({ baseDir: process.cwd(), env }),
    registry,
    logs,
    resourceUrl: new URL(RESOURCE),
    resourceName: "Pet Clinic",
  });
  return { auth, logs, records, registry };
}

function request(authorization?: string, url = RESOURCE, method = "POST") {
  return new Request(url, {
    method,
    headers: authorization ? { authorization } : {},
  });
}

/** The reason of the last authentication failure audited. */
function lastReason(records: ReturnType<typeof quietLogs>["records"]) {
  return records()
    .filter((r) => r.event === "authentication.failed")
    .at(-1)
    ?.get("reason");
}

describe("authentication - scopesFromClaims", function () {
  it("should read a scope string, an scp array or an scp string", function () {
    assert.equals(scopesFromClaims({ scope: " a  b " }), ["a", "b"]);
    assert.equals(scopesFromClaims({ scp: ["a", 1] }), ["a", "1"]);
    assert.equals(scopesFromClaims({ scp: "a" }), ["a"]);
    assert.equals(scopesFromClaims({ scope: 7 }), []);
  });
});

describe("authentication - isLoopbackHost", function () {
  it("should accept only loopback hosts", function () {
    for (const host of [
      "127.0.0.1",
      "127.8.0.1",
      "localhost",
      "::1",
      "[::1]",
    ]) {
      assert.isTrue(isLoopbackHost(host), host);
    }
    for (const host of ["0.0.0.0", "10.0.0.1", "localhost.example.test"]) {
      assert.isFalse(isLoopbackHost(host), host);
    }
  });
});

describe("authentication - none", function () {
  it("should treat every caller as anonymous, and warn that it is unauthenticated", async function () {
    const { auth, logs, records } = await setup({ mode: "none" });
    assert.equals(auth.mode, "none");
    assert.isUndefined(auth.metadata(request()));
    const result = await auth.authenticate(request(), logs);
    assert.isTrue(result.ok);
    assert.equals(result.ok && result.principal, {
      id: "anonymous",
      kind: "anonymous",
      scopes: [],
    });
    const configured = records().find(
      (r) => r.event === "authentication.mode_configured",
    )!;
    assert.equals(configured.get("warning"), "unauthenticated; loopback only");
  });
});

describe("authentication - static-bearer", function () {
  const tokens = [
    { principal: "alice", token: { env: "ALICE" }, scopes: ["pets:read"] },
    { principal: "bob", token: { env: "BOB" } },
  ];

  it("should map a configured token to its principal", async function () {
    const { auth, logs, registry } = await setup({
      mode: "static-bearer",
      staticBearer: { tokens },
    });
    assert.isUndefined(auth.metadata(request()));
    const result = await auth.authenticate(
      request(`bearer ${env.BOB}  `),
      logs,
    );
    assert.isTrue(result.ok);
    if (result.ok) {
      assert.equals(result.principal, {
        id: "static:bob",
        kind: "static",
        name: "bob",
        scopes: [],
      });
      assert.equals(result.authInfo.token, "[static-bearer]");
      assert.equals(result.authInfo.clientId, "bob");
    }
    assert.equals(registry.scrubKnown(env.ALICE), "[REDACTED]");
  });

  it("should challenge a request without a bearer token", async function () {
    const { auth, logs, records } = await setup({
      mode: "static-bearer",
      staticBearer: { tokens },
    });
    for (const header of [undefined, `Basic ${env.ALICE}`, "Bearer a b"]) {
      const result = await auth.authenticate(request(header), logs);
      assert.isFalse(result.ok);
      if (!result.ok) {
        assert.equals(result.response.status, 401);
        assert.equals(
          result.response.headers.get("www-authenticate"),
          'Bearer realm="oag-mcp"',
        );
        assert.equals(await result.response.json(), {
          error: "unauthorized",
          error_description: "Bearer token required",
        });
      }
      assert.equals(lastReason(records), "missing_token");
    }
  });

  it("should challenge an unknown token as invalid", async function () {
    const { auth, logs, records } = await setup({
      mode: "static-bearer",
      staticBearer: { tokens },
    });
    const result = await auth.authenticate(
      request("Bearer not-a-configured-token"),
      logs,
    );
    assert.isFalse(result.ok);
    if (!result.ok) {
      assert.equals(
        result.response.headers.get("www-authenticate"),
        'Bearer realm="oag-mcp", error="invalid_token", error_description="The bearer token is invalid"',
      );
    }
    assert.equals(lastReason(records), "invalid_token");
  });

  it("should refuse a missing token list and weak tokens", async function () {
    await assert.rejects(
      setup({ mode: "static-bearer" }),
      match({ code: "MCP_AUTH_CONFIG_INVALID" }),
    );
    await assert.rejects(
      setup({
        mode: "static-bearer",
        staticBearer: { tokens: [{ principal: "w", token: { env: "WEAK" } }] },
      }),
      match({ code: "MCP_AUTH_TOKEN_WEAK" }),
    );
  });
});

describe("authentication - oauth configuration", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("should refuse a missing oauth section and an insecure issuer", async function () {
    await assert.rejects(
      setup({ mode: "oauth" }),
      match({ code: "MCP_AUTH_CONFIG_INVALID" }),
    );
    await assert.rejects(
      setup({
        mode: "oauth",
        oauth: { issuer: "http://auth.example.test", jwksUri: JWKS_URI },
      }),
      match({ code: "MCP_AUTH_ISSUER_INSECURE" }),
    );
    for (const oauth of [
      { issuer: "http://127.0.0.1:9000", jwksUri: JWKS_URI },
      {
        issuer: "http://auth.example.test",
        jwksUri: JWKS_URI,
        allowInsecureIssuer: true,
      },
    ]) {
      assert.equals((await setup({ mode: "oauth", oauth })).auth.mode, "oauth");
    }
  });

  it("should serve protected resource metadata on GET and HEAD only", async function () {
    const { auth } = await setup({
      mode: "oauth",
      oauth: { issuer: ISSUER, jwksUri: JWKS_URI, requiredScopes: ["mcp"] },
    });
    const base =
      "https://mcp.example.test/.well-known/oauth-protected-resource";
    for (const url of [base, `${base}/mcp`]) {
      const res = auth.metadata(request(undefined, url, "GET"))!;
      assert.equals(res.status, 200);
      assert.equals(res.headers.get("cache-control"), "max-age=300");
      assert.equals(await res.json(), {
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
        resource_name: "Pet Clinic",
      });
    }
    assert.equals(auth.metadata(request(undefined, base, "HEAD"))!.status, 200);
    const post = auth.metadata(request(undefined, base, "POST"))!;
    assert.equals(post.status, 405);
    assert.equals(post.headers.get("allow"), "GET, HEAD");
    assert.isUndefined(auth.metadata(request(undefined, RESOURCE, "GET")));
  });

  it("should discover the JWKS from authorization server metadata", async function () {
    const fetch = serve({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () =>
        json({ issuer: ISSUER, jwks_uri: JWKS_URI }),
    });
    const { records } = await setup({
      mode: "oauth",
      oauth: { issuer: ISSUER },
    });
    assert.equals(fetch.firstCall.args[1], { redirect: "error" });
    assert.equals(
      records()
        .find((r) => r.event === "authentication.mode_configured")!
        .get("validation"),
      "jwt",
    );
  });

  it("should fall back to OpenID configuration under the issuer's path", async function () {
    const issuer = `${ISSUER}/tenant/`;
    serve({
      [`${ISSUER}/.well-known/oauth-authorization-server/tenant`]: () =>
        json({}, 404),
      [`${ISSUER}/tenant/.well-known/openid-configuration`]: () =>
        json({ issuer, jwks_uri: JWKS_URI }),
    });
    assert.equals(
      (await setup({ mode: "oauth", oauth: { issuer } })).auth.mode,
      "oauth",
    );
  });

  it("should refuse metadata that names another issuer", async function () {
    serve({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () =>
        json({ issuer: "https://evil.example.test", jwks_uri: JWKS_URI }),
    });
    await assert.rejects(
      setup({ mode: "oauth", oauth: { issuer: ISSUER } }),
      match({ code: "MCP_AUTH_ISSUER_MISMATCH" }),
    );
  });

  it("should refuse an issuer whose JWKS cannot be discovered", async function () {
    serve({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () =>
        json({ issuer: ISSUER }),
    });
    await assert.rejects(
      setup({ mode: "oauth", oauth: { issuer: ISSUER } }),
      match({ code: "MCP_AUTH_JWKS_UNKNOWN" }),
    );
  });
});

describe("authentication - oauth with JWTs", function () {
  let signing: jose.GenerateKeyPairResult;
  let other: jose.GenerateKeyPairResult;

  before(async function () {
    signing = await jose.generateKeyPair("ES256");
    other = await jose.generateKeyPair("ES256");
  });

  beforeEach(async function () {
    const jwk = { ...(await jose.exportJWK(signing.publicKey)), kid: "k1" };
    serve({ [JWKS_URI]: () => json({ keys: [jwk] }) });
  });

  afterEach(function () {
    sinon.restore();
  });

  function sign(
    claims: jose.JWTPayload,
    opts: { key?: jose.CryptoKey; kid?: string; exp?: number | string } = {},
  ) {
    const jwt = new jose.SignJWT({
      iss: ISSUER,
      aud: RESOURCE,
      sub: "user-1",
      scope: "mcp pets:read",
      ...claims,
    }).setProtectedHeader({ alg: "ES256", kid: opts.kid ?? "k1" });
    if (opts.exp !== undefined) {
      jwt.setExpirationTime(opts.exp);
    }
    return jwt.sign(opts.key ?? signing.privateKey);
  }

  async function jwtAuth(oauth: Record<string, unknown> = {}) {
    return setup({
      mode: "oauth",
      oauth: { issuer: ISSUER, jwksUri: JWKS_URI, ...oauth },
    });
  }

  async function refused(
    auth: HttpAuthenticator,
    logs: ReturnType<typeof quietLogs>["logs"],
    header: string | undefined,
  ) {
    const result = await auth.authenticate(request(header), logs);
    assert.isFalse(result.ok);
    return result.ok ? undefined : result.response;
  }

  it("should accept a valid token and identify the caller opaquely", async function () {
    const { auth, logs, records, registry } = await jwtAuth({
      requiredScopes: ["mcp"],
    });
    const token = await sign({ client_id: "cli" }, { exp: "5m" });
    const result = await auth.authenticate(request(`Bearer ${token}`), logs);
    assert.isTrue(result.ok);
    if (result.ok) {
      assert.equals(
        result.principal.id,
        opaquePrincipalId("oauth", [ISSUER, "user-1"]),
      );
      assert.equals(result.principal.kind, "oauth");
      assert.equals(result.principal.clientId, "cli");
      assert.equals(result.principal.scopes, ["mcp", "pets:read"]);
      assert.equals(result.authInfo.resource, new URL(RESOURCE));
    }
    assert.equals(registry.scrubKnown(token), "[REDACTED]");
    assert.equals(
      records()
        .find((r) => r.event === "authentication.succeeded")!
        .get("scopeCount"),
      2,
    );
  });

  it("should take the client from azp, then sub, when there is no client_id", async function () {
    const { auth, logs } = await jwtAuth();
    const azp = await auth.authenticate(
      request(`Bearer ${await sign({ azp: "web" }, { exp: "5m" })}`),
      logs,
    );
    assert.equals(azp.ok && azp.principal.clientId, "web");
    const sub = await auth.authenticate(
      request(`Bearer ${await sign({}, { exp: "5m" })}`),
      logs,
    );
    assert.equals(sub.ok && sub.principal.clientId, "user-1");
  });

  it("should name why a token's claims or signature are refused", async function () {
    const { auth, logs, records } = await jwtAuth({ audience: [RESOURCE] });
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Promise<string>]> = [
      ["expired", sign({}, { exp: now - 600 })],
      ["audience_mismatch", sign({ aud: "https://other.test" }, { exp: "5m" })],
      ["issuer_mismatch", sign({ iss: "https://other.test" }, { exp: "5m" })],
      ["not_yet_valid", sign({ nbf: now + 600 }, { exp: "5m" })],
      ["claim_exp_invalid", sign({})],
      ["invalid_signature", sign({}, { exp: "5m", key: other.privateKey })],
      ["unknown_signing_key", sign({}, { exp: "5m", kid: "k2" })],
    ];
    for (const [reason, token] of cases) {
      const res = await refused(auth, logs, `Bearer ${await token}`);
      assert.equals(res!.status, 401, reason);
      assert.equals(lastReason(records), reason);
    }
  });

  it("should refuse tokens that are malformed or use another algorithm", async function () {
    const { auth, logs, records } = await jwtAuth({ algorithms: ["RS256"] });
    await refused(auth, logs, `Bearer ${await sign({}, { exp: "5m" })}`);
    assert.equals(lastReason(records), "algorithm_not_allowed");
    const strict = await jwtAuth();
    await refused(strict.auth, strict.logs, "Bearer not.a-jwt");
    assert.equals(lastReason(strict.records), "malformed_token");
    const notClaims = await new jose.CompactSign(
      new TextEncoder().encode("[1]"),
    )
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .sign(signing.privateKey);
    await refused(strict.auth, strict.logs, `Bearer ${notClaims}`);
    assert.equals(lastReason(strict.records), "malformed_token");
  });

  it("should name refusals that happen outside token validation", async function () {
    const { auth, logs, records } = await jwtAuth({
      requiredScopes: ["admin"],
    });
    assert.equals((await refused(auth, logs, undefined))!.status, 401);
    assert.equals(lastReason(records), "missing_token");
    await refused(auth, logs, "Basic abc");
    assert.equals(lastReason(records), "invalid_token");
    const scoped = await refused(
      auth,
      logs,
      `Bearer ${await sign({}, { exp: "5m" })}`,
    );
    assert.equals(scoped!.status, 403);
    assert.equals(lastReason(records), "insufficient_scope");
    // Inside jose's clock tolerance but past expiry for the MCP SDK.
    const lenient = await jwtAuth();
    const now = Math.floor(Date.now() / 1000);
    await refused(
      lenient.auth,
      lenient.logs,
      `Bearer ${await sign({}, { exp: now - 5 })}`,
    );
    assert.equals(lastReason(lenient.records), "expired");
  });

  it("should treat an unreachable JWKS as an invalid token", async function () {
    sinon.restore();
    serve({ [JWKS_URI]: () => json({}, 500) });
    const { auth, logs, records } = await jwtAuth();
    await refused(auth, logs, `Bearer ${await sign({}, { exp: "5m" })}`);
    assert.equals(lastReason(records), "invalid_token");
  });
});

describe("authentication - oauth with introspection", function () {
  let answer: Route;

  beforeEach(function () {
    answer = () => json({});
    serve({ [INTROSPECT]: (init) => answer(init) });
  });

  afterEach(function () {
    sinon.restore();
  });

  async function introspected(oauth: Record<string, unknown> = {}) {
    return setup({
      mode: "oauth",
      oauth: {
        issuer: ISSUER,
        introspection: {
          endpoint: INTROSPECT,
          clientId: { env: "ICID" },
          clientSecret: { env: "ISEC" },
        },
        ...oauth,
      },
    });
  }

  function active(data: Record<string, unknown> = {}) {
    return json({
      active: true,
      aud: [RESOURCE],
      exp: Math.floor(Date.now() / 1000) + 300,
      ...data,
    });
  }

  it("should accept an active token for this resource", async function () {
    let seen: RequestInit | undefined;
    answer = (init) => {
      seen = init;
      return active({ client_id: "cli", sub: "user-2", scope: "mcp" });
    };
    const { auth, logs, records, registry } = await introspected();
    const result = await auth.authenticate(request("Bearer opaque-1"), logs);
    assert.isTrue(result.ok);
    if (result.ok) {
      assert.equals(
        result.principal.id,
        opaquePrincipalId("oauth", [ISSUER, "user-2"]),
      );
      assert.equals(result.principal.clientId, "cli");
      assert.equals(result.principal.scopes, ["mcp"]);
    }
    const headers = seen!.headers as Record<string, string>;
    assert.equals(
      headers.authorization,
      `Basic ${Buffer.from("mcp%20server:introspect-secret-123").toString("base64")}`,
    );
    assert.equals(
      String(seen!.body),
      "token=opaque-1&token_type_hint=access_token",
    );
    assert.equals(seen!.redirect, "error");
    assert.equals(registry.scrubKnown(env.ISEC), "[REDACTED]");
    assert.equals(
      records()
        .find((r) => r.event === "authentication.mode_configured")!
        .get("validation"),
      "introspection",
    );
  });

  it("should accept a single audience string and fall back to sub or unknown", async function () {
    const { auth, logs } = await introspected({ audience: ["api://mcp"] });
    answer = () => active({ aud: "api://mcp", sub: "user-3" });
    const sub = await auth.authenticate(request("Bearer opaque-2"), logs);
    assert.equals(sub.ok && sub.principal.clientId, "user-3");
    answer = () => active({ aud: "api://mcp", iss: ISSUER });
    const unknown = await auth.authenticate(request("Bearer opaque-3"), logs);
    assert.equals(unknown.ok && unknown.principal.clientId, "unknown");
  });

  it("should name why an introspected token is refused", async function () {
    const { auth, logs, records } = await introspected();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["inactive", { active: false }],
      ["issuer_mismatch", { iss: "https://other.test" }],
      ["audience_mismatch", { aud: "https://other.test" }],
      ["audience_mismatch", { aud: undefined }],
      ["expired", { exp: undefined }],
      ["expired", { exp: Math.floor(Date.now() / 1000) - 10 }],
    ];
    for (const [reason, data] of cases) {
      answer = () => active(data);
      const result = await auth.authenticate(request("Bearer opaque"), logs);
      assert.isFalse(result.ok, reason);
      assert.equals(lastReason(records), reason);
    }
  });

  it("should answer with a server error when introspection is unavailable", async function () {
    const { auth, logs, records } = await introspected();
    for (const respond of [
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ error: "nope" }, 503),
      () => new Response("not json"),
    ]) {
      answer = respond;
      const result = await auth.authenticate(request("Bearer opaque"), logs);
      assert.isFalse(result.ok);
      if (!result.ok) {
        assert.equals(result.response.status, 500);
      }
      assert.equals(lastReason(records), "server_error");
    }
  });
});
