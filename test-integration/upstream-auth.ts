"use strict";
/**
 * Upstream API authentication against the mock API: every supported
 * mechanism, OAuth2 client credentials caching and renewal, and credential
 * confidentiality towards agent code.
 */
import referee from "@sinonjs/referee";

import { OagMcpError } from "../lib/errors.js";
import type { OagMcpService } from "../lib/runtime/service.js";
import {
  LOCAL,
  SECRET_ENV,
  defaultArtifact,
  fileLogs,
  runtimeConfig,
  service,
} from "./helpers/env.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  API_KEY,
  BEARER_TOKEN,
  type MockApi,
  startMockApi,
} from "./helpers/mock-api.js";
import { type AuthServer, startAuthServer } from "./helpers/auth-server.js";

const { assert, refute } = referee;

let api: MockApi;
let auth: AuthServer;
let svc: OagMcpService;
let logRecords: () => Array<Record<string, unknown>>;

before(async function () {
  this.timeout(120000);
  auth = await startAuthServer();
  api = await startMockApi({ oauthTokens: auth.upstreamTokens });
  const l = fileLogs("upstream");
  logRecords = l.records;
  svc = await service(
    await defaultArtifact(),
    runtimeConfig(api, {}, auth),
    l.logs,
  );
});

after(async function () {
  await api?.close();
  await auth?.close();
});

const run = (code: string) => svc.execute({ code }, LOCAL);
const last = () => api.requests.at(-1)!;

describe("upstream-auth - supported mechanisms", function () {
  it("should send an apiKey header for the first configured alternative", async function () {
    const res = await run(
      `return (await sdk.PetsApi.listPets({ limit: 1 })).length;`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(last().headers["x-api-key"], API_KEY);
    assert.isUndefined(last().headers.authorization);
  });

  it("should send an apiKey query parameter", async function () {
    const res = await run(
      `return (await sdk.OwnersApi.listOwners({ city: "Sydney" })).map((o) => o.name);`,
    );
    assert.equals(res.result, ["Grace"]);
    assert.equals(last().query.api_key, API_KEY);
  });

  it("should send HTTP Basic credentials", async function () {
    const res = await run(
      `await sdk.AdminApi.deletePet({ petId: 7 });\nreturn "ok";`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    assert.equals(last().method, "DELETE");
    assert.equals(
      last().headers.authorization,
      `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64")}`,
    );
  });

  it("should send HTTP Bearer credentials", async function () {
    const res = await run(`return await sdk.StoreApi.getStoreInventory();`);
    assert.equals(res.result, { food: 12, toys: 4, leashes: 7 });
    assert.equals(last().headers.authorization, `Bearer ${BEARER_TOKEN}`);
  });

  it("should obtain OAuth2 client credentials tokens with the operation's scopes", async function () {
    const before = auth.tokenRequests;
    const res = await run(
      `return await sdk.PetsApi.createPet({ newPet: { name: "Ivy", species: "rabbit" } });`,
    );
    assert.isTrue(res.ok, JSON.stringify(res.error));
    const token = last().headers.authorization.slice(7);
    assert.equals(auth.upstreamTokens.get(token), ["pets:write"]);
    assert.equals(auth.tokenRequests, before + 1);
  });

  it("should not attach credentials to public operations", async function () {
    await run(`return (await sdk.PetsApi.getPetById({ petId: 1 })).name;`);
    assert.isUndefined(last().headers.authorization);
    assert.isUndefined(last().headers["x-api-key"]);
  });
});

describe("upstream-auth - OAuth2 token caching and renewal", function () {
  it("should reuse a cached token across executions and renew it after expiry", async function () {
    this.timeout(30000);
    const l = fileLogs("oauth-cache");
    auth.upstreamTokenLifetime = 32; // 30s refresh skew → valid for ~2s
    const fresh = await service(
      await defaultArtifact(),
      runtimeConfig(api, {}, auth),
      l.logs,
    );
    const create = `return (await sdk.PetsApi.createPet({ newPet: { name: "C", species: "cat" } })).id;`;
    const start = auth.tokenRequests;
    await fresh.execute({ code: create }, LOCAL);
    const t1 = last().headers.authorization;
    await fresh.execute({ code: create }, LOCAL);
    const t2 = last().headers.authorization;
    assert.equals(t2, t1);
    assert.equals(auth.tokenRequests, start + 1);
    await new Promise((r) => setTimeout(r, 2300));
    const res = await fresh.execute({ code: create }, LOCAL);
    assert.isTrue(res.ok, JSON.stringify(res.error));
    refute.equals(last().headers.authorization, t1);
    assert.equals(auth.tokenRequests, start + 2);
    const events = l
      .records()
      .filter((r) => r.logCategory === "security_audit")
      .map((r) => r.event);
    assert.contains(events, "upstream.token.issue");
    assert.contains(events, "upstream.token.refresh");
    auth.upstreamTokenLifetime = 3600;
  });

  it("should renew a token that the API rejects", async function () {
    const fresh = await service(
      await defaultArtifact(),
      runtimeConfig(api, {}, auth),
    );
    const create = `return (await sdk.PetsApi.createPet({ newPet: { name: "D", species: "dog" } })).id;`;
    await fresh.execute({ code: create }, LOCAL);
    const token = last().headers.authorization.slice(7);
    auth.upstreamTokens.delete(token); // revoked upstream
    const rejected = await fresh.execute({ code: create }, LOCAL);
    assert.equals(rejected.error!.type, "api_error");
    assert.equals(rejected.error!.status, 401);
    const retried = await fresh.execute({ code: create }, LOCAL);
    assert.isTrue(retried.ok, JSON.stringify(retried.error));
    refute.equals(last().headers.authorization.slice(7), token);
  });
});

describe("upstream-auth - configuration and confidentiality", function () {
  it("should fail fast when a configured secret is missing", async function () {
    try {
      await service(
        await defaultArtifact(),
        runtimeConfig(api, {
          upstreamAuth: {
            schemes: {
              bearerAuth: { token: { env: "OAG_MCP_TEST_UNSET_VAR" } },
            },
          },
        }),
      );
      assert(false);
    } catch (e) {
      assert.equals((e as OagMcpError).code, "UPSTREAM_AUTH_CONFIG_INVALID");
      refute.contains((e as Error).message, BEARER_TOKEN);
    }
  });

  it("should not silently downgrade when no credentials are configured", async function () {
    const noAuth = await service(
      await defaultArtifact(),
      runtimeConfig(api, { upstreamAuth: { schemes: {} } }),
    );
    const before = api.requests.length;
    const res = await noAuth.execute(
      { code: `return await sdk.PetsApi.listPets({});` },
      LOCAL,
    );
    assert.equals(res.error!.type, "upstream_auth_error");
    assert.equals(res.error!.reason, "credential_not_configured");
    assert.equals(api.requests.length, before);
  });

  it("should keep credentials out of agent bindings, environment, errors and results", async function () {
    const probes = [
      `const s = sdk as any; return JSON.stringify(Object.getOwnPropertyNames(s.PetsApi).map((k) => String(s.PetsApi[k])));`,
      `try { return await sdk.PetsApi.getPetById({ petId: 404 }); } catch (e: any) { return JSON.stringify({ m: e.message, r: e.response ? [...e.response.headers] : null }); }`,
      `return await sdk.StoreApi.getStoreInventory({ headers: { "x-echo-auth": "1" } });`,
      `return String((globalThis as any).Deno?.env?.toObject?.() ?? "none");`,
    ];
    for (const code of probes) {
      const res = await run(code);
      const text = JSON.stringify(res);
      for (const secret of Object.values(SECRET_ENV)) {
        refute.contains(text, secret, code);
      }
    }
    const echoed = await run(probes[2]);
    assert.equals(
      (echoed.result as { echoed: string }).echoed,
      "Bearer [REDACTED]",
    );
  });

  it("should strip credentials that agent code tries to supply", async function () {
    const res = await run(
      `return (await sdk.StoreApi.getStoreInventory({ headers: { Authorization: "Bearer agent-chosen" } }));`,
    );
    assert.isTrue(res.ok);
    assert.equals(last().headers.authorization, `Bearer ${BEARER_TOKEN}`);
    assert.contains(
      logRecords().map((r) => r.event),
      "credential.agent_supplied_stripped",
    );
  });
});
