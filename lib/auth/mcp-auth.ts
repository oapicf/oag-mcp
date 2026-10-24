"use strict";
/**
 * Authentication of callers of the MCP server over Streamable HTTP.
 *
 * Modes:
 * - `none`: local development only; the server refuses to bind a
 *   non-loopback address in this mode.
 * - `static-bearer`: pre-shared bearer tokens mapped to named principals.
 *   This does NOT implement MCP OAuth discovery/authorization; it suits
 *   clients that let you configure an Authorization header.
 * - `oauth`: OAuth 2.0 resource server per the MCP authorization
 *   specification: RFC 9728 protected resource metadata, Bearer challenges,
 *   and token validation (issuer, audience/resource, expiry, scopes) via a
 *   configured JWKS or RFC 7662 introspection at an external authorization
 *   server.
 *
 * Every protected request is authenticated; session identifiers are never
 * treated as credentials, and tokens are only accepted in the Authorization
 * header.
 *
 * @module auth/mcp-auth
 */
import crypto from "node:crypto";

import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import * as jose from "jose";

import type {
  RuntimeConfig,
  SecretResolver,
} from "../config/runtime-config.js";
import { OagMcpError } from "../errors.js";
import type { Logs } from "../logger.js";
import type { SecretRegistry } from "../util/redact.js";
import type { Principal } from "../types.js";
import { opaquePrincipalId } from "./policy.js";

/** Result of authenticating a request. */
export type AuthResult =
  | { ok: true; principal: Principal; authInfo: AuthInfo }
  | { ok: false; response: Response };

/** Authenticator for HTTP requests. */
export interface HttpAuthenticator {
  readonly mode: "none" | "static-bearer" | "oauth";
  /** Authenticate one request. */
  authenticate(req: Request, logs: Logs): Promise<AuthResult>;
  /** Serve discovery metadata, or undefined when the path is not metadata. */
  metadata(req: Request): Response | undefined;
}

/** Error carrying a machine-readable token validation reason. */
class TokenRejected extends OAuthError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(OAuthErrorCode.InvalidToken, message);
  }
}

/**
 * Parse scopes from token claims (`scope` string or `scp` array/string).
 *
 * @param {Object} claims - token claims
 * @return {Array} scopes
 */
export function scopesFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims.scope ?? claims.scp;
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === "string") {
    return raw.split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Map jose errors to stable reasons.
 *
 * @private
 */
function _joseReason(err: unknown): string {
  if (err instanceof jose.errors.JWTExpired) {
    return "expired";
  }
  if (err instanceof jose.errors.JWTClaimValidationFailed) {
    return err.claim === "aud"
      ? "audience_mismatch"
      : err.claim === "iss"
        ? "issuer_mismatch"
        : err.claim === "nbf"
          ? "not_yet_valid"
          : `claim_${err.claim}_invalid`;
  }
  if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
    return "invalid_signature";
  }
  if (err instanceof jose.errors.JWKSNoMatchingKey) {
    return "unknown_signing_key";
  }
  if (err instanceof jose.errors.JOSEAlgNotAllowed) {
    return "algorithm_not_allowed";
  }
  if (
    err instanceof jose.errors.JWSInvalid ||
    err instanceof jose.errors.JWTInvalid
  ) {
    return "malformed_token";
  }
  return "invalid_token";
}

/**
 * Whether a host binds only to loopback.
 *
 * @param {String} host - bind host
 * @return {Boolean} true for loopback
 */
export function isLoopbackHost(host: string): boolean {
  return (
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) ||
    host.startsWith("127.")
  );
}

/**
 * Discover the JWKS URI from authorization server metadata.
 *
 * @private
 */
async function _discoverJwks(issuer: string): Promise<string> {
  const u = new URL(issuer);
  const pathPart = u.pathname.replace(/\/+$/, "");
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${pathPart}`,
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { redirect: "error" });
      if (!res.ok) {
        continue;
      }
      const meta = (await res.json()) as Record<string, unknown>;
      if (meta.issuer !== issuer) {
        throw new OagMcpError(
          "MCP_AUTH_ISSUER_MISMATCH",
          `Authorization server metadata at ${url} reports issuer ${String(meta.issuer)}, expected ${issuer}`,
        );
      }
      if (typeof meta.jwks_uri === "string") {
        return meta.jwks_uri;
      }
    } catch (err) {
      if (err instanceof OagMcpError) {
        throw err;
      }
    }
  }
  throw new OagMcpError(
    "MCP_AUTH_JWKS_UNKNOWN",
    `Could not discover jwks_uri for issuer ${issuer}`,
    {
      hint: "Set mcpAuth.oauth.jwksUri explicitly, or configure introspection.",
    },
  );
}

/**
 * JWT access token verifier using a remote JWKS.
 */
class JwtVerifier implements OAuthTokenVerifier {
  private readonly jwks: ReturnType<typeof jose.createRemoteJWKSet>;

  constructor(
    jwksUri: string,
    private readonly o: {
      issuer: string;
      audiences: string[];
      algorithms: string[];
      clockToleranceSec: number;
      resource: URL;
    },
  ) {
    this.jwks = jose.createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, this.jwks, {
        issuer: this.o.issuer,
        audience: this.o.audiences,
        algorithms: this.o.algorithms,
        clockTolerance: this.o.clockToleranceSec,
        requiredClaims: ["exp"],
      }));
    } catch (err) {
      throw new TokenRejected(_joseReason(err), "The access token is invalid");
    }
    const claims = payload as Record<string, unknown>;
    return {
      token,
      clientId: String(
        claims.client_id ?? claims.azp ?? claims.sub ?? "unknown",
      ),
      scopes: scopesFromClaims(claims),
      expiresAt: payload.exp,
      resource: this.o.resource,
      extra: { sub: payload.sub, iss: payload.iss },
    };
  }
}

/**
 * RFC 7662 token introspection verifier for opaque tokens.
 */
class IntrospectionVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly o: {
      endpoint: string;
      clientId: string;
      clientSecret: string;
      issuer: string;
      audiences: string[];
      resource: URL;
    },
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let res: Response;
    try {
      res = await fetch(this.o.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.o.clientId)}:${encodeURIComponent(this.o.clientSecret)}`).toString("base64")}`,
        },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new OAuthError(
        OAuthErrorCode.ServerError,
        "Token introspection is unavailable",
      );
    }
    if (!res.ok) {
      throw new OAuthError(
        OAuthErrorCode.ServerError,
        "Token introspection failed",
      );
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (data.active !== true) {
      throw new TokenRejected("inactive", "The access token is not active");
    }
    if (data.iss !== undefined && data.iss !== this.o.issuer) {
      throw new TokenRejected(
        "issuer_mismatch",
        "The access token was issued by another issuer",
      );
    }
    const aud = Array.isArray(data.aud)
      ? data.aud.map(String)
      : data.aud
        ? [String(data.aud)]
        : [];
    if (!aud.some((a) => this.o.audiences.includes(a))) {
      throw new TokenRejected(
        "audience_mismatch",
        "The access token is not intended for this server",
      );
    }
    if (typeof data.exp !== "number" || data.exp * 1000 < Date.now()) {
      throw new TokenRejected("expired", "The access token has expired");
    }
    return {
      token,
      clientId: String(data.client_id ?? data.sub ?? "unknown"),
      scopes: scopesFromClaims(data),
      expiresAt: data.exp,
      resource: this.o.resource,
      extra: { sub: data.sub, iss: data.iss ?? this.o.issuer },
    };
  }
}

/**
 * Timing-safe comparison of two strings via their digests.
 *
 * @private
 */
function _safeEqual(a: string, b: string): boolean {
  const da = crypto.createHash("sha256").update(a).digest();
  const db = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Bearer token from an Authorization header.
 *
 * @private
 */
function _bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+([^\s]+)\s*$/i.exec(h) : null;
  return m ? m[1] : undefined;
}

/**
 * JSON error response with a WWW-Authenticate challenge.
 *
 * @private
 */
function _challenge(
  status: number,
  error: string | undefined,
  description: string,
): Response {
  const params = [`realm="oag-mcp"`];
  if (error) {
    params.push(`error="${error}"`, `error_description="${description}"`);
  }
  return new Response(
    JSON.stringify({
      error: error ?? "unauthorized",
      error_description: description,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer ${params.join(", ")}`,
      },
    },
  );
}

/** Options for {@link createHttpAuthenticator}. */
export interface AuthenticatorOptions {
  config: RuntimeConfig;
  resolver: SecretResolver;
  registry: SecretRegistry;
  logs: Logs;
  /** Public URL of the MCP endpoint (the protected resource). */
  resourceUrl: URL;
  resourceName: string;
}

/**
 * Create the HTTP authenticator for the configured mode.
 *
 * @param {Object} opts - options
 * @return {Promise} authenticator
 */
export async function createHttpAuthenticator(
  opts: AuthenticatorOptions,
): Promise<HttpAuthenticator> {
  const { config, logs } = opts;
  const mode = config.mcpAuth.mode;
  if (mode === "none") {
    logs.audit(
      "authentication.mode_configured",
      "success",
      {
        mode,
        warning: "unauthenticated; loopback only",
      },
      "warn",
    );
    return {
      mode,
      metadata: () => undefined,
      authenticate: async (_req, l) => {
        const principal: Principal = {
          id: "anonymous",
          kind: "anonymous",
          scopes: [],
        };
        l.audit("authentication.succeeded", "success", {
          mode,
          principalId: principal.id,
        });
        return {
          ok: true,
          principal,
          authInfo: {
            token: "",
            clientId: "anonymous",
            scopes: [],
            extra: { principal },
          },
        };
      },
    };
  }
  if (mode === "static-bearer") {
    const tokens = config.mcpAuth.staticBearer?.tokens;
    if (!tokens || tokens.length === 0) {
      throw new OagMcpError(
        "MCP_AUTH_CONFIG_INVALID",
        "mcpAuth.mode is static-bearer but mcpAuth.staticBearer.tokens is empty",
      );
    }
    const entries = tokens.map((t) => {
      const value = opts.resolver.resolve(
        t.token,
        `mcpAuth token for ${t.principal}`,
      );
      if (value.length < 16) {
        throw new OagMcpError(
          "MCP_AUTH_TOKEN_WEAK",
          `Static bearer token for ${t.principal} is shorter than 16 characters`,
          { hint: "Generate one with: openssl rand -hex 32" },
        );
      }
      opts.registry.add(value);
      return { ...t, value };
    });
    logs.audit("authentication.mode_configured", "success", {
      mode,
      principals: entries.map((e) => e.principal),
      note: "static bearer does not implement MCP OAuth discovery",
    });
    return {
      mode,
      metadata: () => undefined,
      authenticate: async (req, l) => {
        const token = _bearer(req);
        if (!token) {
          l.audit(
            "authentication.failed",
            "failure",
            { mode, reason: "missing_token" },
            "warn",
          );
          return {
            ok: false,
            response: _challenge(401, undefined, "Bearer token required"),
          };
        }
        // Compare against every entry to keep timing independent of position.
        let match: (typeof entries)[number] | undefined;
        for (const e of entries) {
          if (_safeEqual(token, e.value) && !match) {
            match = e;
          }
        }
        if (!match) {
          l.audit(
            "authentication.failed",
            "failure",
            { mode, reason: "invalid_token" },
            "warn",
          );
          return {
            ok: false,
            response: _challenge(
              401,
              "invalid_token",
              "The bearer token is invalid",
            ),
          };
        }
        const principal: Principal = {
          id: `static:${match.principal}`,
          kind: "static",
          name: match.principal,
          scopes: match.scopes,
        };
        l.audit("authentication.succeeded", "success", {
          mode,
          principalId: principal.id,
        });
        return {
          ok: true,
          principal,
          authInfo: {
            token: "[static-bearer]",
            clientId: match.principal,
            scopes: match.scopes,
            extra: { principal },
          },
        };
      },
    };
  }

  // OAuth resource server.
  const o = config.mcpAuth.oauth;
  if (!o) {
    throw new OagMcpError(
      "MCP_AUTH_CONFIG_INVALID",
      "mcpAuth.mode is oauth but mcpAuth.oauth is not configured",
    );
  }
  const issuerUrl = new URL(o.issuer);
  if (
    issuerUrl.protocol !== "https:" &&
    !o.allowInsecureIssuer &&
    !isLoopbackHost(issuerUrl.hostname)
  ) {
    throw new OagMcpError(
      "MCP_AUTH_ISSUER_INSECURE",
      `OAuth issuer ${o.issuer} must use HTTPS`,
      {
        hint: "Use an HTTPS issuer; allowInsecureIssuer is for local testing only.",
      },
    );
  }
  const resource = new URL(o.resource ?? opts.resourceUrl.toString());
  const audiences =
    o.audience && o.audience.length > 0 ? o.audience : [resource.toString()];
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  let verifier: OAuthTokenVerifier;
  let validation: "jwt" | "introspection";
  if (o.introspection) {
    const clientId = opts.resolver.resolve(
      o.introspection.clientId,
      "introspection client id",
    );
    const clientSecret = opts.resolver.resolve(
      o.introspection.clientSecret,
      "introspection client secret",
    );
    opts.registry.add(clientSecret);
    verifier = new IntrospectionVerifier({
      endpoint: o.introspection.endpoint,
      clientId,
      clientSecret,
      issuer: o.issuer,
      audiences,
      resource,
    });
    validation = "introspection";
  } else {
    const jwksUri = o.jwksUri ?? (await _discoverJwks(o.issuer));
    verifier = new JwtVerifier(jwksUri, {
      issuer: o.issuer,
      audiences,
      algorithms: o.algorithms,
      clockToleranceSec: o.clockToleranceSec,
      resource,
    });
    validation = "jwt";
  }
  const prm = {
    resource: resource.toString(),
    authorization_servers: [o.issuer],
    scopes_supported: o.scopesSupported ?? o.requiredScopes,
    bearer_methods_supported: ["header"],
    resource_name: opts.resourceName,
  };
  const prmPaths = new Set([
    "/.well-known/oauth-protected-resource",
    new URL(resourceMetadataUrl).pathname,
  ]);
  logs.audit("authentication.mode_configured", "success", {
    mode,
    validation,
    issuer: o.issuer,
    requiredScopes: o.requiredScopes,
  });
  return {
    mode,
    metadata: (req) => {
      const url = new URL(req.url);
      if (!prmPaths.has(url.pathname)) {
        return undefined;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }
      return new Response(JSON.stringify(prm), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=300",
        },
      });
    },
    authenticate: async (req, l) => {
      try {
        const authInfo = await verifyBearerToken(
          req.headers.get("authorization"),
          {
            verifier,
            requiredScopes: o.requiredScopes,
            resourceMetadataUrl,
            expectedResource: resource,
          },
        );
        const extra = (authInfo.extra ?? {}) as { sub?: string; iss?: string };
        const principal: Principal = {
          id: opaquePrincipalId("oauth", [
            String(extra.iss ?? o.issuer),
            String(extra.sub ?? authInfo.clientId),
          ]),
          kind: "oauth",
          clientId: authInfo.clientId,
          scopes: authInfo.scopes,
          expiresAt: authInfo.expiresAt,
        };
        opts.registry.add(authInfo.token);
        l.audit("token.validated", "success", {
          mode,
          validation,
          principalId: principal.id,
          scopeCount: principal.scopes.length,
        });
        l.audit("authentication.succeeded", "success", {
          mode,
          principalId: principal.id,
        });
        return {
          ok: true,
          principal,
          authInfo: { ...authInfo, extra: { ...authInfo.extra, principal } },
        };
      } catch (err) {
        const code = err instanceof OAuthError ? err.code : "server_error";
        const reason =
          err instanceof TokenRejected
            ? err.reason
            : !req.headers.get("authorization")
              ? "missing_token"
              : code === OAuthErrorCode.InsufficientScope
                ? "insufficient_scope"
                : /expired/i.test(String((err as Error).message))
                  ? "expired"
                  : /resource/i.test(String((err as Error).message))
                    ? "resource_mismatch"
                    : String(code);
        l.audit(
          "token.validation_failed",
          "failure",
          { mode, validation, reason },
          "warn",
        );
        l.audit("authentication.failed", "failure", { mode, reason }, "warn");
        return {
          ok: false,
          response: bearerAuthChallengeResponse(err, {
            requiredScopes: o.requiredScopes,
            resourceMetadataUrl,
          }),
        };
      }
    },
  };
}
