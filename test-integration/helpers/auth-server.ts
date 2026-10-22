"use strict";
/**
 * A minimal local OAuth 2.0 authorization server for tests. It is NOT part
 * of oag-mcp: oag-mcp never implements an authorization server. It provides:
 *
 * - RFC 8414 metadata and a JWKS for MCP access tokens (JWT) it mints;
 * - a client_credentials token endpoint for upstream OAuth2 tests, issuing
 *   opaque tokens that the mock API accepts;
 * - an RFC 7662 introspection endpoint for opaque MCP tokens.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import * as jose from "jose";

export const UPSTREAM_CLIENT_ID = "petclinic-client";
export const UPSTREAM_CLIENT_SECRET = "petclinic-client-secret-xyz";
export const INTROSPECTION_CLIENT_ID = "oag-mcp-rs";
export const INTROSPECTION_CLIENT_SECRET = "oag-mcp-rs-secret-123";

export interface AuthServer {
  issuer: string;
  jwksUri: string;
  tokenUrl: string;
  introspectionUrl: string;
  /** Upstream tokens issued (shared with the mock API). */
  upstreamTokens: Map<string, string[]>;
  tokenRequests: number;
  /** Lifetime of issued upstream tokens in seconds. */
  upstreamTokenLifetime: number;
  /** Opaque MCP tokens for introspection: token -> claims. */
  opaqueTokens: Map<string, Record<string, unknown>>;
  mint(
    claims: Record<string, unknown>,
    opts?: { expiresIn?: number; key?: "good" | "rogue"; issuer?: string },
  ): Promise<string>;
  close(): Promise<void>;
}

/**
 * Start the authorization server.
 *
 * @param {Object} [opts] - options
 * @return {Promise} server
 */
export async function startAuthServer(
  opts: { upstreamTokens?: Map<string, string[]> } = {},
): Promise<AuthServer> {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const rogue = await jose.generateKeyPair("RS256");
  const jwk = {
    ...(await jose.exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  const upstreamTokens = opts.upstreamTokens ?? new Map<string, string[]>();
  const opaqueTokens = new Map<string, Record<string, unknown>>();
  const state = { tokenRequests: 0, upstreamTokenLifetime: 3600 };
  let issuer = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const basic = (req.headers.authorization ?? "").replace(/^Basic\s+/i, "");
    const [cid, csec] = Buffer.from(basic, "base64")
      .toString("utf8")
      .split(":")
      .map(decodeURIComponent);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint: `${issuer}/token`,
        introspection_endpoint: `${issuer}/introspect`,
        grant_types_supported: ["client_credentials"],
      });
    }
    if (url.pathname === "/jwks") {
      return json(200, { keys: [jwk] });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      state.tokenRequests++;
      if (body.get("grant_type") !== "client_credentials")
        return json(400, { error: "unsupported_grant_type" });
      const id = cid ?? body.get("client_id");
      const secret = csec ?? body.get("client_secret");
      if (id !== UPSTREAM_CLIENT_ID || secret !== UPSTREAM_CLIENT_SECRET)
        return json(401, { error: "invalid_client" });
      const token = `upstream_${crypto.randomUUID()}`;
      const scopes = (body.get("scope") ?? "").split(" ").filter(Boolean);
      upstreamTokens.set(token, scopes);
      return json(200, {
        access_token: token,
        token_type: "Bearer",
        expires_in: state.upstreamTokenLifetime,
        scope: scopes.join(" "),
      });
    }
    if (url.pathname === "/introspect" && req.method === "POST") {
      if (
        cid !== INTROSPECTION_CLIENT_ID ||
        csec !== INTROSPECTION_CLIENT_SECRET
      )
        return json(401, { error: "invalid_client" });
      const claims = opaqueTokens.get(body.get("token") ?? "");
      if (!claims) return json(200, { active: false });
      return json(200, { active: true, ...claims });
    }
    return json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    tokenUrl: `${issuer}/token`,
    introspectionUrl: `${issuer}/introspect`,
    upstreamTokens,
    opaqueTokens,
    get tokenRequests() {
      return state.tokenRequests;
    },
    get upstreamTokenLifetime() {
      return state.upstreamTokenLifetime;
    },
    set upstreamTokenLifetime(v: number) {
      state.upstreamTokenLifetime = v;
    },
    async mint(claims, o = {}) {
      const key = o.key === "rogue" ? rogue.privateKey : privateKey;
      const now = Math.floor(Date.now() / 1000);
      return new jose.SignJWT({ ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(o.issuer ?? issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + (o.expiresIn ?? 600))
        .sign(key);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
