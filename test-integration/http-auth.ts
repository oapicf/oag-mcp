"use strict";
/**
 * MCP access control over Streamable HTTP (static bearer and OAuth resource
 * server with a local authorization server), per-caller permissions for
 * every SDK operation, concurrent caller isolation and non-forwarding of MCP
 * credentials.
 */
import fs from "node:fs";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import referee from "@sinonjs/referee";

import {
  defaultArtifact,
  runCli,
  startHttpServer,
  upstreamAuthConfig,
  workDir,
  writeConfig,
} from "./helpers/env.js";
import { type MockApi, startMockApi } from "./helpers/mock-api.js";
import {
  type AuthServer,
  INTROSPECTION_CLIENT_ID,
  INTROSPECTION_CLIENT_SECRET,
  startAuthServer,
} from "./helpers/auth-server.js";

const { assert, refute } = referee;

const READER_TOKEN = "reader-token-0123456789abcdef";
const ADMIN_TOKEN = "admin-token-0123456789abcdef";

let api: MockApi;
let auth: AuthServer;
let art: string;

before(async function () {
  this.timeout(120000);
  art = await defaultArtifact();
  auth = await startAuthServer();
  api = await startMockApi({ oauthTokens: auth.upstreamTokens });
});

after(async function () {
  await api?.close();
  await auth?.close();
});

async function rpc(
  url: string,
  token?: string,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

async function connect(url: string, token: string) {
  const client = new Client({ name: "it", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("http-auth - unauthenticated mode", function () {
  it("should refuse to bind a non-loopback address without authentication", function () {
    const dir = workDir("none-remote");
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(),
    });
    const res = runCli([
      "serve",
      art,
      "--transport",
      "streamable-http",
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--config",
      config,
    ]);
    assert.equals(res.status, 1);
    assert.match(res.stderr, /MCP_AUTH_REQUIRED/);
    assert.match(res.stderr, /security\.unauthenticated_nonloopback_refused/);
  });
});

describe("http-auth - static bearer", function () {
  let staticAudit: string;
  let server: Awaited<ReturnType<typeof startHttpServer>>;

  before(async function () {
    this.timeout(60000);
    const dir = workDir("static");
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(auth),
      mcpAuth: {
        mode: "static-bearer",
        staticBearer: {
          tokens: [
            {
              principal: "reader",
              token: { env: "MCP_READER_TOKEN" },
              scopes: ["pets:read"],
            },
            {
              principal: "admin",
              token: { env: "MCP_ADMIN_TOKEN" },
              scopes: ["pets:read", "admin"],
            },
          ],
        },
      },
      authorization: {
        default: "deny",
        rules: [
          {
            id: "readers-get",
            principals: ["reader"],
            scopes: ["pets:read"],
            allow: ["method:GET"],
            deny: ["StoreApi.*"],
          },
          { id: "admins-all", principals: ["admin"], allow: ["*"] },
        ],
      },
    });
    server = await startHttpServer(
      [
        art,
        "--config",
        config,
        "--audit-log-file",
        path.join(dir, "audit.log"),
      ],
      {
        MCP_READER_TOKEN: READER_TOKEN,
        MCP_ADMIN_TOKEN: ADMIN_TOKEN,
      },
    );
    staticAudit = path.join(dir, "audit.log");
  });

  after(async function () {
    await server?.stop();
  });

  it("should reject missing and invalid tokens on every request", async function () {
    const missing = await rpc(server.url);
    assert.equals(missing.status, 401);
    assert.match(
      missing.headers.get("www-authenticate"),
      /^Bearer realm="oag-mcp"/,
    );
    const invalid = await rpc(server.url, "not-a-valid-token-at-all");
    assert.equals(invalid.status, 401);
    assert.match(
      invalid.headers.get("www-authenticate"),
      /error="invalid_token"/,
    );
    const ok = await rpc(server.url, READER_TOKEN);
    assert.equals(ok.status, 200);
  });

  it("should reject tokens passed in the URL", async function () {
    const res = await fetch(`${server.url}?access_token=${READER_TOKEN}`, {
      method: "POST",
    });
    assert.equals(res.status, 400);
  });

  it("should filter search results by caller permissions", async function () {
    const reader = await connect(server.url, READER_TOKEN);
    const admin = await connect(server.url, ADMIN_TOKEN);
    const r = (await reader.callTool({ name: "search", arguments: {} }))
      .structuredContent as {
      apis: Array<{ api: string; methods: Array<{ id: string }> }>;
    };
    const a = (await admin.callTool({ name: "search", arguments: {} }))
      .structuredContent as { apis: Array<{ api: string }> };
    const readerIds = r.apis.flatMap((g) => g.methods.map((m) => m.id));
    refute.contains(readerIds, "AdminApi.deletePet");
    refute.contains(
      r.apis.map((g) => g.api),
      "StoreApi",
    );
    assert.contains(
      a.apis.map((g) => g.api),
      "StoreApi",
    );
    await reader.close();
    await admin.close();
  });

  it("should check each SDK operation in one execute call before it reaches the API", async function () {
    const reader = await connect(server.url, READER_TOKEN);
    const before = api.requests.length;
    const res = (
      await reader.callTool({
        name: "execute",
        arguments: {
          code: `const pets = await sdk.PetsApi.listPets({ limit: 2 });\nawait sdk.AdminApi.deletePet({ petId: pets[0].id });\nreturn "deleted";`,
        },
      })
    ).structuredContent as {
      ok: boolean;
      error: { type: string; reason: string; operation: string };
    };
    assert.isFalse(res.ok);
    assert.equals(res.error.reason, "authorization_denied");
    assert.equals(res.error.operation, "AdminApi.deletePet");
    const reached = api.requests.slice(before);
    assert.equals(
      reached.map((r) => `${r.method} ${r.path}`),
      ["GET /v1/pets"],
    );
    // Hidden operations are still enforced when called directly.
    const hidden = (
      await reader.callTool({
        name: "execute",
        arguments: { code: `return await sdk.StoreApi.getStoreInventory();` },
      })
    ).structuredContent as { error: { reason: string } };
    assert.equals(hidden.error.reason, "authorization_denied");
    await reader.close();
  });

  it("should allow the admin principal and never forward MCP tokens upstream", async function () {
    const admin = await connect(server.url, ADMIN_TOKEN);
    const before = api.requests.length;
    const res = (
      await admin.callTool({
        name: "execute",
        arguments: {
          code: `await sdk.AdminApi.deletePet({ petId: 2 });\nreturn (await sdk.StoreApi.getStoreInventory()).food;`,
        },
      })
    ).structuredContent as { ok: boolean; result: number };
    assert.isTrue(res.ok);
    assert.equals(res.result, 12);
    for (const r of api.requests.slice(before)) {
      refute.contains(JSON.stringify(r.headers), ADMIN_TOKEN);
    }
    await admin.close();
  });

  it("should keep concurrent callers isolated", async function () {
    const reader = await connect(server.url, READER_TOKEN);
    const admin = await connect(server.url, ADMIN_TOKEN);
    const code = `return await sdk.StoreApi.getStoreInventory();`;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? admin : reader)
          .callTool({ name: "execute", arguments: { code } })
          .then((r) => r.structuredContent as { ok: boolean }),
      ),
    );
    assert.equals(
      results.map((r) => r.ok),
      [false, true, false, true, false, true],
    );
    await reader.close();
    await admin.close();
  });

  it("should audit an authorization decision for every attempted SDK operation", function () {
    const records = fs
      .readFileSync(staticAudit, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const decisions = records.filter(
      (r) =>
        r.event === "authorization.allowed" ||
        r.event === "authorization.denied",
    );
    assert.greater(decisions.length, 5);
    for (const d of decisions) {
      assert.isString(d.operation);
      assert.isString(d.policyId);
      assert.isString(d.principalId);
      assert.isString(d.executionId);
      assert.isString(d.requestId);
      assert.equals(d.logCategory, "security_audit");
    }
    assert.contains(
      records.map((r) => r.event),
      "authentication.failed",
    );
    refute.contains(JSON.stringify(records), READER_TOKEN);
  });
});

describe("http-auth - OAuth resource server", function () {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let resource: string;

  before(async function () {
    this.timeout(60000);
    const dir = workDir("oauth");
    const port = 39000 + Math.floor(Math.random() * 1000);
    resource = `http://127.0.0.1:${port}/mcp`;
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(auth),
      mcpAuth: {
        mode: "oauth",
        oauth: {
          issuer: auth.issuer,
          requiredScopes: ["mcp:tools"],
          allowInsecureIssuer: true,
        },
      },
      authorization: {
        default: "deny",
        rules: [
          { id: "read", scopes: ["pets:read"], allow: ["method:GET"] },
          { id: "write", scopes: ["pets:write"], allow: ["PetsApi.createPet"] },
        ],
      },
      http: { port },
    });
    server = await startHttpServer([
      art,
      "--config",
      config,
      "--port",
      String(port),
    ]);
  });

  after(async function () {
    await server?.stop();
  });

  it("should publish protected resource metadata", async function () {
    const res = await fetch(
      new URL("/.well-known/oauth-protected-resource/mcp", resource),
    );
    assert.equals(res.status, 200);
    const meta = (await res.json()) as Record<string, unknown>;
    assert.equals(meta.resource, resource);
    assert.equals(meta.authorization_servers, [auth.issuer]);
    assert.equals(meta.bearer_methods_supported, ["header"]);
  });

  it("should challenge unauthenticated requests with the metadata URL", async function () {
    const res = await rpc(resource);
    assert.equals(res.status, 401);
    assert.match(
      res.headers.get("www-authenticate"),
      /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
  });

  it("should reject invalid, expired, wrongly targeted and wrongly issued tokens", async function () {
    const base = {
      sub: "user-1",
      client_id: "app",
      aud: resource,
      scope: "mcp:tools pets:read",
    };
    const cases: Array<[string, string]> = [
      ["garbage", "garbage-token-value"],
      ["expired", await auth.mint(base, { expiresIn: -120 })],
      [
        "audience",
        await auth.mint({ ...base, aud: "https://other.example.test/mcp" }),
      ],
      [
        "issuer",
        await auth.mint(base, { issuer: "https://evil.example.test" }),
      ],
      ["signature", await auth.mint(base, { key: "rogue" })],
    ];
    for (const [label, token] of cases) {
      const res = await rpc(resource, token);
      assert.equals(res.status, 401, label);
      assert.match(res.headers.get("www-authenticate"), /invalid_token/, label);
    }
  });

  it("should return insufficient_scope for tokens lacking the required scope", async function () {
    const token = await auth.mint({
      sub: "user-1",
      client_id: "app",
      aud: resource,
      scope: "pets:read",
    });
    const res = await rpc(resource, token);
    assert.equals(res.status, 403);
    assert.match(res.headers.get("www-authenticate"), /insufficient_scope/);
  });

  it("should authorise SDK operations from token scopes", async function () {
    const reader = await connect(
      resource,
      await auth.mint({
        sub: "user-r",
        client_id: "app",
        aud: resource,
        scope: "mcp:tools pets:read",
      }),
    );
    const writer = await connect(
      resource,
      await auth.mint({
        sub: "user-w",
        client_id: "app",
        aud: resource,
        scope: "mcp:tools pets:write",
      }),
    );
    const create = `return (await sdk.PetsApi.createPet({ newPet: { name: "Q", species: "cat" } })).name;`;
    const r1 = (
      await reader.callTool({ name: "execute", arguments: { code: create } })
    ).structuredContent as { ok: boolean; error?: { reason: string } };
    const r2 = (
      await writer.callTool({ name: "execute", arguments: { code: create } })
    ).structuredContent as { ok: boolean; result: string };
    assert.equals(r1.error!.reason, "authorization_denied");
    assert.isTrue(r2.ok);
    assert.equals(r2.result, "Q");
    // The MCP access token is not the upstream token.
    const upstreamAuth = api.requests.at(-1)!.headers.authorization;
    assert.match(upstreamAuth, /^Bearer upstream_/);
    await reader.close();
    await writer.close();
  });
});

describe("http-auth - OAuth introspection", function () {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let url: string;

  before(async function () {
    this.timeout(60000);
    const dir = workDir("introspect");
    const port = 40000 + Math.floor(Math.random() * 1000);
    url = `http://127.0.0.1:${port}/mcp`;
    const config = writeConfig(dir, {
      upstream: { baseUrl: api.baseUrl },
      upstreamAuth: upstreamAuthConfig(auth),
      mcpAuth: {
        mode: "oauth",
        oauth: {
          issuer: auth.issuer,
          allowInsecureIssuer: true,
          introspection: {
            endpoint: auth.introspectionUrl,
            clientId: { env: "RS_ID" },
            clientSecret: { env: "RS_SECRET" },
          },
        },
      },
      http: { port },
    });
    server = await startHttpServer(
      [art, "--config", config, "--port", String(port)],
      {
        RS_ID: INTROSPECTION_CLIENT_ID,
        RS_SECRET: INTROSPECTION_CLIENT_SECRET,
      },
    );
  });

  after(async function () {
    await server?.stop();
  });

  it("should accept active opaque tokens for this resource and reject others", async function () {
    const now = Math.floor(Date.now() / 1000);
    auth.opaqueTokens.set("opaque-good-token-123", {
      sub: "u1",
      client_id: "app",
      aud: url,
      scope: "x",
      exp: now + 600,
      iss: auth.issuer,
    });
    auth.opaqueTokens.set("opaque-other-aud-123", {
      sub: "u1",
      client_id: "app",
      aud: "https://elsewhere.test/mcp",
      exp: now + 600,
    });
    auth.opaqueTokens.set("opaque-expired-1234", {
      sub: "u1",
      client_id: "app",
      aud: url,
      exp: now - 10,
    });
    assert.equals((await rpc(url, "opaque-good-token-123")).status, 200);
    assert.equals((await rpc(url, "opaque-other-aud-123")).status, 401);
    assert.equals((await rpc(url, "opaque-expired-1234")).status, 401);
    assert.equals((await rpc(url, "opaque-unknown-1234")).status, 401);
  });
});
