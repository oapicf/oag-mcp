"use strict";
/**
 * Local mock of the Pet Clinic fixture API. It enforces the security
 * requirements declared in test/fixtures/petclinic/openapi.yaml and records
 * every request so tests can assert on what reached the upstream API.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export const API_KEY = "test-api-key-0123456789";
export const BEARER_TOKEN = "test-bearer-token-abcdefghij";
export const ADMIN_USER = "clinic-admin";
export const ADMIN_PASSWORD = "s3cret-admin-pass";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
}

export interface MockApi {
  url: string;
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
  /** Tokens accepted for clinicOAuth, with scopes. */
  oauthTokens: Map<string, string[]>;
}

const SPECIES = ["dog", "cat", "bird", "rabbit"];

export const PETS = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  name: [
    "Biscuit",
    "Mochi",
    "Pepper",
    "Nori",
    "Ziggy",
    "Olive",
    "Tofu",
    "Kiwi",
    "Maple",
    "Pip",
    "Juno",
    "Rex",
  ][i],
  species: SPECIES[i % 4],
  birthDate: `20${10 + i}-0${(i % 9) + 1}-15`,
  ownerId: (i % 3) + 1,
  vaccinated: i % 3 !== 0,
  weightKg: 2 + i * 1.5,
}));

const OWNERS = [
  { id: 1, name: "Ada", city: "Melbourne" },
  { id: 2, name: "Grace", city: "Sydney" },
  { id: 3, name: "Linus", city: "Melbourne" },
];

function send(
  res: http.ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  });
  res.end(text);
}

/**
 * Start the mock API.
 *
 * @param {Object} [opts] - options
 * @return {Promise} running mock
 */
export async function startMockApi(
  opts: { oauthTokens?: Map<string, string[]> } = {},
): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const oauthTokens = opts.oauthTokens ?? new Map<string, string[]>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
    }
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: body || undefined,
    });
    const auth = headers.authorization ?? "";
    const apiKeyOk = headers["x-api-key"] === API_KEY;
    const bearerOk = auth === `Bearer ${BEARER_TOKEN}`;
    const basicOk =
      auth ===
      `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64")}`;
    const oauthScopes = auth.startsWith("Bearer ")
      ? oauthTokens.get(auth.slice(7))
      : undefined;
    const p = url.pathname;
    const deny = () =>
      send(res, 401, {
        code: "unauthorized",
        message: "missing or invalid credentials",
      });

    if (req.method === "GET" && p === "/v1/pets") {
      if (!apiKeyOk && !bearerOk) return deny();
      let list = PETS.slice();
      if (url.searchParams.get("species"))
        list = list.filter(
          (x) => x.species === url.searchParams.get("species"),
        );
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return send(res, 200, list.slice(0, limit));
    }
    if (req.method === "POST" && p === "/v1/pets") {
      if (!oauthScopes || !oauthScopes.includes("pets:write")) return deny();
      const input = JSON.parse(body || "{}");
      if (!input.name)
        return send(res, 400, { code: "invalid", message: "name is required" });
      return send(res, 201, { id: 100, ...input });
    }
    const petMatch = /^\/v1\/pets\/([^/]+)$/.exec(p);
    if (petMatch && req.method === "GET") {
      const pet = PETS.find((x) => String(x.id) === petMatch[1]);
      return pet
        ? send(res, 200, pet)
        : send(res, 404, {
            code: "not_found",
            message: `pet ${petMatch[1]} not found`,
          });
    }
    if (petMatch && req.method === "DELETE") {
      if (!basicOk) return deny();
      return send(res, 204);
    }
    const visitsMatch = /^\/v1\/pets\/([^/]+)\/visits$/.exec(p);
    if (visitsMatch && req.method === "GET") {
      if (!apiKeyOk && !bearerOk) return deny();
      const id = Number(visitsMatch[1]);
      if (id === 13) {
        // A response the spec does not describe: the SDK fails to map it.
        return send(res, 200, null);
      }
      return send(res, 200, [
        {
          id: id * 10 + 1,
          date: "2026-03-01",
          reason: "checkup",
          costCents: 5000 + id * 100,
        },
        {
          id: id * 10 + 2,
          date: "2026-06-12",
          reason: "vaccination",
          costCents: 3000,
        },
      ]);
    }
    if (req.method === "GET" && p === "/v1/owners") {
      if (url.searchParams.get("api_key") !== API_KEY) return deny();
      const city = url.searchParams.get("city");
      return send(
        res,
        200,
        OWNERS.filter((o) => !city || o.city === city),
      );
    }
    if (req.method === "GET" && p === "/v1/store/inventory") {
      if (!bearerOk) return deny();
      if (headers["x-echo-auth"]) {
        // Misbehaving endpoint used to test redaction of echoed credentials.
        return send(res, 200, { echoed: auth, food: 3 } as unknown as Record<
          string,
          number
        >);
      }
      return send(res, 200, { food: 12, toys: 4, leashes: 7 });
    }
    if (req.method === "GET" && p === "/v1/legacy/pets") {
      return send(res, 302, undefined, { location: "/v1/public/pets" });
    }
    if (req.method === "GET" && p === "/v1/public/pets") {
      return send(res, 200, PETS.slice(0, 3));
    }
    if (req.method === "GET" && p === "/v1/external/docs") {
      return send(res, 302, undefined, {
        location: "http://evil.example.test/steal",
      });
    }
    if (req.method === "GET" && p === "/v1/health") {
      return send(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && p === "/v1/slow") {
      const delay = Number(url.searchParams.get("delayMs") ?? "1000");
      setTimeout(() => send(res, 200, { status: "slow-ok" }), delay);
      return;
    }
    return send(res, 404, { code: "not_found", message: "no route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    baseUrl: `${url}/v1`,
    requests,
    oauthTokens,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
