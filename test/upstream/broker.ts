"use strict";
import referee from "@sinonjs/referee";
import sinon from "sinon";

import { AuthorizationPolicy } from "../../lib/server/authorization.js";
import { SecretResolver } from "../../lib/util/secrets.js";
import { SecretRegistry } from "../../lib/util/redact.js";
import type { OperationBinding, Principal } from "../../lib/types.js";
import {
  RequestBroker,
  compilePathTemplate,
} from "../../lib/upstream/broker.js";
import { ServiceIdentityCredentialProvider } from "../../lib/upstream/credentials.js";
import type { CredentialProvider } from "../../lib/upstream/types.js";
import { SCHEMES, fakeFetch, quietLogs } from "../helpers/fakes.js";

const { assert, refute } = referee;

const OPS: OperationBinding[] = [
  {
    id: "PetsApi.listPets",
    className: "PetsApi",
    methodName: "listPets",
    httpMethod: "GET",
    path: "/pets",
    tags: ["pets"],
    security: [{ apiKeyHeader: [] }],
  },
  {
    id: "PetsApi.getPetById",
    className: "PetsApi",
    methodName: "getPetById",
    httpMethod: "GET",
    path: "/pets/{petId}",
    tags: ["pets"],
    security: [],
  },
  {
    id: "OwnersApi.listOwners",
    className: "OwnersApi",
    methodName: "listOwners",
    httpMethod: "GET",
    path: "/owners",
    tags: ["owners"],
    security: [{ apiKeyQuery: [] }],
  },
  {
    id: "PetsApi.createPet",
    className: "PetsApi",
    methodName: "createPet",
    httpMethod: "POST",
    path: "/pets",
    tags: ["pets"],
    security: [],
  },
  {
    id: "AdminApi.deletePet",
    className: "AdminApi",
    methodName: "deletePet",
    httpMethod: "DELETE",
    path: "/pets/{petId}",
    tags: ["admin"],
    security: [{ adminBasic: [] }],
  },
];
const principal: Principal = {
  id: "static:reader",
  kind: "static",
  name: "reader",
  scopes: [],
};
const BASE = "https://api.example.test/v1";

function broker(
  fetchImpl: typeof fetch,
  extra: Partial<{
    policy: AuthorizationPolicy;
    allowedOrigins: string[];
    maxResponseBytes: number;
    followRedirects: boolean;
    timeoutMs: number;
    provider: CredentialProvider;
    operations: OperationBinding[];
  }> = {},
) {
  const q = quietLogs();
  const provider =
    extra.provider ??
    new ServiceIdentityCredentialProvider({
      schemes: {
        apiKeyHeader: { apiKey: { env: "KEY" } },
        apiKeyQuery: { apiKey: { env: "KEY" } },
        adminBasic: { username: { env: "U" }, password: { env: "P" } },
      },
      schemeInfo: SCHEMES,
      resolver: new SecretResolver({
        baseDir: process.cwd(),
        env: { KEY: "broker-key-123456", U: "admin", P: "broker-pass-123456" },
      }),
      registry: new SecretRegistry(),
      logs: q.logs,
      allowInsecureTokenUrl: true,
      baseUrl: BASE,
    });
  const b = new RequestBroker({
    operations: extra.operations ?? OPS,
    schemes: SCHEMES,
    provider,
    policy: extra.policy ?? new AuthorizationPolicy(),
    network: {
      baseUrl: BASE,
      allowedOrigins: extra.allowedOrigins ?? [],
      followRedirects: extra.followRedirects ?? true,
      maxRedirects: 3,
      timeoutMs: extra.timeoutMs ?? 5000,
      maxResponseBytes: extra.maxResponseBytes ?? 1024 * 1024,
      maxRequestBytes: 1024,
    },
    fetchImpl,
  });
  return { b, ...q };
}

const req = (
  binding: string,
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
) => ({
  rid: 1,
  binding,
  url,
  method,
  headers,
  body: null,
});
const ctx = (logs: ReturnType<typeof quietLogs>["logs"]) => ({
  principal,
  executionId: "exec_1",
  requestId: "req_1",
  logs,
});

describe("broker - compilePathTemplate", function () {
  it("should match concrete paths under the base path only", function () {
    const re = compilePathTemplate("/v1", "/pets/{petId}/visits");
    assert.isTrue(re.test("/v1/pets/12/visits"));
    assert.isTrue(re.test("/v1/pets/a%2Fb/visits"));
    assert.isFalse(re.test("/v1/pets/12/visits/x"));
    assert.isFalse(re.test("/pets/12/visits"));
    assert.isFalse(re.test("/v1/pets//visits"));
  });
});

describe("broker - RequestBroker.handle", function () {
  it("should inject credentials host-side and strip agent-supplied ones", async function () {
    const f = fakeFetch(
      () =>
        new Response("[]", {
          status: 200,
          headers: {
            "set-cookie": "sid=1",
            "content-type": "application/json",
          },
        }),
    );
    const { b, logs, records } = broker(f);
    const res = await b.handle(
      req("PetsApi.listPets", `${BASE}/pets?limit=2`, "GET", {
        "X-Api-Key": "agent-guess",
        Authorization: "Bearer agent",
        Accept: "application/json",
      }),
      ctx(logs),
      new AbortController().signal,
    );
    assert.isTrue(res.ok);
    const sent = f.calls[0];
    const headers = sent.init.headers as Record<string, string>;
    assert.equals(headers["X-Api-Key"], "broker-key-123456");
    assert.isUndefined(headers.Authorization);
    assert.equals(headers.Accept, "application/json");
    if (res.ok) {
      refute(res.headers.some(([k]) => k === "set-cookie"));
    }
    // One allowed decision, marked as modified: agent-supplied credentials
    // were removed.
    const decisions = records().filter((r) =>
      r.event.startsWith("authorization."),
    );
    assert.equals(decisions.length, 1);
    assert.equals(decisions[0].event, "authorization.allowed");
    assert.equals(decisions[0].outcome, "modified");
    assert.equals(
      (decisions[0].get("strippedCredentials") as string[]).sort(),
      ["authorization", "x-api-key"],
    );
  });

  it("should add query api keys and remove agent-supplied ones", async function () {
    const f = fakeFetch(() => new Response("[]", { status: 200 }));
    const { b, logs } = broker(f);
    await b.handle(
      req(
        "OwnersApi.listOwners",
        `${BASE}/owners?api_key=guess&city=Melbourne`,
      ),
      ctx(logs),
      new AbortController().signal,
    );
    assert.equals(f.calls[0].url.searchParams.getAll("api_key"), [
      "broker-key-123456",
    ]);
    assert.equals(f.calls[0].url.searchParams.get("city"), "Melbourne");
  });

  it("should deny and audit operations the policy forbids before contacting the API", async function () {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const policy = new AuthorizationPolicy({
      default: "deny",
      rules: [{ id: "read", allow: ["method:GET"], deny: [] }],
    });
    const { b, logs, records } = broker(f, { policy });
    const res = await b.handle(
      req("AdminApi.deletePet", `${BASE}/pets/1`, "DELETE"),
      ctx(logs),
      new AbortController().signal,
    );
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.reason, "authorization_denied");
    assert.equals(f.calls.length, 0);
    const audit = records().find((r) => r.event === "authorization.denied")!;
    assert.equals(audit.get("operation"), "AdminApi.deletePet");
    assert.equals(audit.get("policyId"), "default");
    assert.equals(audit.outcome, "denied");
  });

  it("should reject requests that do not match the operation or base URL", async function () {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const { b, logs, records } = broker(f);
    const signal = new AbortController().signal;
    for (const r of [
      req("PetsApi.getPetById", "https://evil.example.test/v1/pets/1"),
      req("PetsApi.getPetById", `${BASE}/owners`),
      req("PetsApi.getPetById", `${BASE}/pets/1`, "DELETE"),
      req("PetsApi.getPetById", `${BASE}/pets/1/../../admin`),
      req("Nope.method", `${BASE}/pets`),
    ]) {
      const res = await b.handle(r, ctx(logs), signal);
      assert.isFalse(res.ok, r.url);
    }
    assert.equals(f.calls.length, 0);
    const events = records().map((r) => r.event);
    assert.contains(events, "network.destination_denied");
    assert.contains(events, "execution.boundary_violation");
  });

  it("should follow same-origin redirects and deny other origins", async function () {
    const f = fakeFetch((url) => {
      if (url.pathname === "/v1/pets/1")
        return new Response(null, {
          status: 302,
          headers: { location: "/v1/pets/2" },
        });
      if (url.pathname === "/v1/pets/2")
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.test/x" },
        });
      return new Response("{}", { status: 200 });
    });
    const { b, logs, records } = broker(f);
    const res = await b.handle(
      req("PetsApi.getPetById", `${BASE}/pets/1`),
      ctx(logs),
      new AbortController().signal,
    );
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.reason, "redirect_denied");
    assert.equals(f.calls.length, 2);
    assert.contains(
      records().map((r) => r.event),
      "network.redirect_denied",
    );
  });

  it("should not forward credentials on redirects to another allowed origin", async function () {
    const f = fakeFetch((url) =>
      url.hostname === "api.example.test"
        ? new Response(null, {
            status: 307,
            headers: { location: "https://cdn.example.test/pets?api_key=x" },
          })
        : new Response("[]", { status: 200 }),
    );
    const { b, logs } = broker(f, {
      allowedOrigins: ["https://cdn.example.test"],
    });
    const res = await b.handle(
      req("PetsApi.listPets", `${BASE}/pets`),
      ctx(logs),
      new AbortController().signal,
    );
    assert.isTrue(res.ok);
    const second = f.calls[1];
    assert.equals(second.url.hostname, "cdn.example.test");
    assert.isUndefined(
      (second.init.headers as Record<string, string>)["X-Api-Key"],
    );
  });

  it("should bound response size", async function () {
    const f = fakeFetch(() => new Response("x".repeat(5000), { status: 200 }));
    const { b, logs } = broker(f, { maxResponseBytes: 2048 });
    const res = await b.handle(
      req("PetsApi.getPetById", `${BASE}/pets/1`),
      ctx(logs),
      new AbortController().signal,
    );
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.reason, "response_too_large");
  });

  it("should report missing upstream credentials without calling the API", async function () {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const q = quietLogs();
    const provider = new ServiceIdentityCredentialProvider({
      schemes: {},
      schemeInfo: SCHEMES,
      resolver: new SecretResolver({ baseDir: process.cwd(), env: {} }),
      registry: new SecretRegistry(),
      logs: q.logs,
      allowInsecureTokenUrl: true,
      baseUrl: BASE,
    });
    const b = new RequestBroker({
      operations: OPS,
      schemes: SCHEMES,
      provider,
      policy: new AuthorizationPolicy(),
      network: {
        baseUrl: BASE,
        allowedOrigins: [],
        followRedirects: true,
        maxRedirects: 3,
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        maxRequestBytes: 1024,
      },
      fetchImpl: f,
    });
    const res = await b.handle(
      req("PetsApi.listPets", `${BASE}/pets`),
      ctx(q.logs),
      new AbortController().signal,
    );
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.type, "upstream_auth_error");
    assert.equals(f.calls.length, 0);
    assert.contains(
      q.records().map((r) => r.event),
      "credential.lookup_failed",
    );
  });
});

describe("broker - handle request limits and failures", function () {
  const signal = () => new AbortController().signal;

  it("should refuse and audit a request URL that cannot be parsed", async function () {
    const f = fakeFetch(() => new Response("{}"));
    const { b, logs, records } = broker(f);
    const res = await b.handle(
      req("PetsApi.listPets", "not a url"),
      ctx(logs),
      signal(),
    );
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.reason, "invalid_url");
    assert.equals(f.calls.length, 0);
    const denied = records().find(
      (r) => r.event === "network.destination_denied",
    )!;
    assert.equals(denied.get("reason"), "invalid_url");
  });

  it("should send a base64 request body decoded", async function () {
    const f = fakeFetch(() => new Response("{}", { status: 201 }));
    const { b, logs } = broker(f);
    const res = await b.handle(
      {
        ...req("PetsApi.createPet", `${BASE}/pets`, "POST"),
        body: Buffer.from('{"name":"Rex"}').toString("base64"),
        bodyEncoding: "base64",
      },
      ctx(logs),
      signal(),
    );
    assert.isTrue(res.ok);
    assert.equals(
      Buffer.from(f.calls[0].init.body as Uint8Array).toString(),
      '{"name":"Rex"}',
    );
  });

  it("should refuse and audit a request body over the size limit without calling the API", async function () {
    const f = fakeFetch(() => new Response("{}"));
    const { b, logs, records } = broker(f);
    const res = await b.handle(
      {
        ...req("PetsApi.createPet", `${BASE}/pets`, "POST"),
        body: "x".repeat(2048),
      },
      ctx(logs),
      signal(),
    );
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.reason, "request_too_large");
    assert.equals(f.calls.length, 0);
    const limit = records().find(
      (r) => r.event === "execution.resource_limit",
    )!;
    assert.equals(limit.get("limit"), "maxRequestBytes");
  });

  it("should report an API that cannot be reached", async function () {
    const f = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { b, logs, records } = broker(f);
    const res = await b.handle(
      req("PetsApi.getPetById", `${BASE}/pets/1`),
      ctx(logs),
      signal(),
    );
    assert.isFalse(res.ok);
    if (!res.ok) {
      assert.equals(res.error.type, "upstream_unreachable");
      assert.equals(res.error.reason, "network_error");
    }
    const failed = records().find((r) => r.event === "upstream.call.failed")!;
    assert.equals(failed.get("reason"), "network_error");
    assert.equals(failed.get("error"), "TypeError");
  });

  it("should time out an API that does not respond, and tell it apart from the execution ending", async function () {
    // Like fetch, reject once the signal aborts (or at once if it has).
    const hang = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) {
            reject(signal.reason);
          }
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const slow = broker(hang, { timeoutMs: 50 });
    const timedOut = await slow.b.handle(
      req("PetsApi.getPetById", `${BASE}/pets/1`),
      ctx(slow.logs),
      signal(),
    );
    assert.isFalse(timedOut.ok);
    if (!timedOut.ok) assert.equals(timedOut.error.reason, "upstream_timeout");

    const ended = broker(hang);
    const execution = new AbortController();
    const pending = ended.b.handle(
      req("PetsApi.getPetById", `${BASE}/pets/1`),
      ctx(ended.logs),
      execution.signal,
    );
    execution.abort();
    const res = await pending;
    assert.isFalse(res.ok);
    if (!res.ok) assert.equals(res.error.reason, "network_error");
    const failed = ended
      .records()
      .find((r) => r.event === "upstream.call.failed")!;
    assert.equals(failed.get("reason"), "execution_ended");
  });

  it("should refuse redirects when following them is disabled, or after too many", async function () {
    const loop = () =>
      fakeFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "/v1/pets/2" },
          }),
      );
    const reason = async (b: ReturnType<typeof broker>) => {
      await b.b.handle(
        req("PetsApi.getPetById", `${BASE}/pets/1`),
        ctx(b.logs),
        signal(),
      );
      return b
        .records()
        .find((r) => r.event === "network.redirect_denied")
        ?.get("reason");
    };
    const disabled = loop();
    assert.equals(
      await reason(broker(disabled, { followRedirects: false })),
      "redirects_disabled",
    );
    assert.equals(disabled.calls.length, 1);
    const endless = loop();
    assert.equals(await reason(broker(endless)), "too_many_redirects");
    assert.equals(endless.calls.length, 4, "the first request and 3 redirects");
  });

  it("should not forward credentials when a permitted redirect goes to another origin", async function () {
    const f = fakeFetch((url) =>
      url.hostname === "api.example.test"
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://cdn.example.test/owners?api_key=echoed&city=x",
            },
          })
        : new Response("[]"),
    );
    const { b, logs } = broker(f, {
      allowedOrigins: ["https://cdn.example.test"],
    });
    const res = await b.handle(
      req("OwnersApi.listOwners", `${BASE}/owners`),
      ctx(logs),
      signal(),
    );
    assert.isTrue(res.ok);
    assert.equals(
      f.calls[0].url.searchParams.get("api_key"),
      "broker-key-123456",
    );
    assert.isNull(f.calls[1].url.searchParams.get("api_key"));
    assert.equals(f.calls[1].url.searchParams.get("city"), "x");

    const h = fakeFetch((url) =>
      url.hostname === "api.example.test"
        ? new Response(null, {
            status: 307,
            headers: { location: "https://cdn.example.test/pets" },
          })
        : new Response("[]"),
    );
    const other = broker(h, { allowedOrigins: ["https://cdn.example.test"] });
    await other.b.handle(
      req("PetsApi.listPets", `${BASE}/pets`),
      ctx(other.logs),
      signal(),
    );
    const sent = (i: number) =>
      h.calls[i].init.headers as Record<string, string>;
    assert.equals(sent(0)["X-Api-Key"], "broker-key-123456");
    assert.isUndefined(sent(1)["X-Api-Key"]);
  });

  it("should turn a POST into a GET without a body after a 303 redirect, but keep it after a 307", async function () {
    const redirecting = (status: number) =>
      fakeFetch((url) =>
        url.pathname === "/v1/pets"
          ? new Response(null, {
              status,
              headers: { location: "/v1/pets/1" },
            })
          : new Response("{}"),
      );
    const send = async (f: ReturnType<typeof fakeFetch>) => {
      const { b, logs } = broker(f);
      await b.handle(
        { ...req("PetsApi.createPet", `${BASE}/pets`, "POST"), body: "{}" },
        ctx(logs),
        signal(),
      );
      return f.calls[1].init;
    };
    const seeOther = await send(redirecting(303));
    assert.equals(seeOther.method, "GET");
    assert.isUndefined(seeOther.body);
    const temporary = await send(redirecting(307));
    assert.equals(temporary.method, "POST");
    assert.equals(temporary.body, "{}");
  });

  it("should discard a cached OAuth token that the API rejects", async function () {
    const provider: CredentialProvider = {
      id: "fake",
      has: () => true,
      apply: async () => ({
        headers: { Authorization: "Bearer t" },
        query: {},
      }),
      invalidate: sinon.spy(),
    };
    const operations: OperationBinding[] = [
      { ...OPS[0], security: [{ clinicOAuth: [] }] },
    ];
    const f = fakeFetch(() => new Response("{}", { status: 401 }));
    const { b, logs } = broker(f, { provider, operations });
    const res = await b.handle(
      req("PetsApi.listPets", `${BASE}/pets`),
      ctx(logs),
      signal(),
    );
    assert.isTrue(res.ok);
    if (res.ok) assert.equals(res.status, 401);
    const invalidate = provider.invalidate as sinon.SinonSpy;
    assert.equals(invalidate.callCount, 1);
    assert.equals(invalidate.firstCall.args[0], "clinicOAuth");
  });
});
