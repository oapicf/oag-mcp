"use strict";
/**
 * Local mock of the Pet Store API in examples/auth-combinations/. It
 * enforces the one security scheme it is started with, and records every
 * request so tests can assert on what reached the upstream API.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { RecordedRequest } from "./mock-api.js";

export const PETSTORE_API_KEY = "petstore-api-key-0123456789";
export const PETSTORE_TOKEN = "petstore-token-abcdefghij";
export const PETSTORE_USERNAME = "petstore-user";
export const PETSTORE_PASSWORD = "petstore-pass-xyz";

/** The secrets the example configurations refer to, by variable name. */
export const PETSTORE_ENV = {
  PETSTORE_API_KEY,
  PETSTORE_TOKEN,
  PETSTORE_USERNAME,
  PETSTORE_PASSWORD,
};

export interface PetstoreApi {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Start the Pet Store API, accepting only the credentials of one upstream
 * scheme (as the folder name part, e.g. `api-key-header`).
 *
 * @param {String} upstream - the upstream scheme id
 * @param {Map} oauthTokens - access tokens issued by the test authorization
 *   server, and their scopes
 * @return {Promise} the running API
 */
export async function startPetstoreApi(
  upstream: string,
  oauthTokens: Map<string, string[]>,
): Promise<PetstoreApi> {
  const requests: RecordedRequest[] = [];
  const pets = [{ id: 1, name: "Rex", species: "dog" }];

  const authorised = (r: RecordedRequest, write: boolean): boolean => {
    const auth = r.headers.authorization ?? "";
    switch (upstream) {
      case "none":
        return true;
      case "api-key-header":
        return r.headers["x-api-key"] === PETSTORE_API_KEY;
      case "api-key-query":
        return r.query.api_key === PETSTORE_API_KEY;
      case "basic":
        return (
          auth ===
          `Basic ${Buffer.from(`${PETSTORE_USERNAME}:${PETSTORE_PASSWORD}`).toString("base64")}`
        );
      case "bearer":
        return auth === `Bearer ${PETSTORE_TOKEN}`;
      default: {
        const scopes = oauthTokens.get(auth.replace(/^Bearer /, "")) ?? [];
        return scopes.includes(write ? "pets:write" : "pets:read");
      }
    }
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
      }
      const r: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body: body || undefined,
      };
      requests.push(r);
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const write = r.method === "POST";
      if (!authorised(r, write)) {
        return send(401, { message: "missing or invalid credentials" });
      }
      if (r.method === "GET" && r.path === "/v1/pets") {
        return send(200, pets.slice(0, Number(r.query.limit ?? "100")));
      }
      if (write && r.path === "/v1/pets") {
        const pet = { id: pets.length + 1, ...JSON.parse(body || "{}") };
        pets.push(pet);
        return send(201, pet);
      }
      const m = /^\/v1\/pets\/(\d+)$/.exec(r.path);
      const pet = m && pets.find((p) => p.id === Number(m[1]));
      return pet && r.method === "GET"
        ? send(200, pet)
        : send(404, { message: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
