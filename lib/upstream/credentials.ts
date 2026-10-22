"use strict";
/**
 * Upstream API credential providers.
 *
 * A {@link CredentialProvider} turns an OpenAPI security scheme into
 * request headers or query parameters on the trusted host side. Agent code
 * never sees provider objects, configuration or credential values.
 *
 * Version one ships {@link ServiceIdentityCredentialProvider}: one
 * explicitly configured upstream identity shared by every MCP caller. The
 * interface receives the request principal so that a future per-caller
 * provider can map MCP principals to their own upstream credentials. MCP
 * access tokens are never forwarded upstream.
 *
 * @module upstream/credentials
 */
import type { Principal } from "../auth/policy.js";
import type {
  SecretResolver,
  UpstreamSchemeConfig,
} from "../config/runtime-config.js";
import { OagMcpError } from "../errors.js";
import type { Logs } from "../logging/logger.js";
import { type SecretRegistry, sanitizeError } from "../logging/redact.js";
import type { OperationBinding, SecuritySchemeInfo } from "../types.js";

/** Context passed to credential providers. */
export interface CredentialContext {
  principal: Principal;
  operation: OperationBinding;
  executionId?: string;
  requestId?: string;
  logs: Logs;
  signal?: AbortSignal;
}

/** Credentials applied to one outgoing request. */
export interface AppliedCredential {
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** Provider boundary for upstream credentials. */
export interface CredentialProvider {
  readonly id: string;
  /** Whether credentials are configured for the scheme. */
  has(schemeName: string): boolean;
  /** Produce credentials for one scheme. */
  apply(
    scheme: SecuritySchemeInfo,
    scopes: string[],
    ctx: CredentialContext,
  ): Promise<AppliedCredential>;
  /** Forget cached credentials after the upstream rejected them. */
  invalidate(schemeName: string, ctx: CredentialContext): void;
}

/** Error raised when upstream credentials cannot be produced. */
export class UpstreamAuthError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamAuthError";
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

interface ResolvedScheme {
  info: SecuritySchemeInfo;
  config: UpstreamSchemeConfig;
  apiKey?: string;
  username?: string;
  password?: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
}

/** Options for {@link ServiceIdentityCredentialProvider}. */
export interface ServiceIdentityOptions {
  schemes: Record<string, UpstreamSchemeConfig>;
  schemeInfo: Record<string, SecuritySchemeInfo>;
  resolver: SecretResolver;
  registry: SecretRegistry;
  logs: Logs;
  allowInsecureTokenUrl: boolean;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Refresh tokens this many seconds before expiry. */
  refreshSkewSec?: number;
}

/**
 * Whether a URL is safe for sending client secrets.
 *
 * @private
 */
function _secureUrl(u: URL): boolean {
  return (
    u.protocol === "https:" ||
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)
  );
}

/**
 * Single upstream service identity loaded from runtime configuration.
 */
export class ServiceIdentityCredentialProvider implements CredentialProvider {
  readonly id = "service-identity";
  private readonly resolved = new Map<string, ResolvedScheme>();
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<CachedToken>>();
  private readonly fetchImpl: typeof fetch;
  private readonly skewSec: number;

  /**
   * Validate configuration and resolve all secret references eagerly so
   * misconfiguration fails at startup.
   *
   * @param {Object} opts - options
   */
  constructor(private readonly opts: ServiceIdentityOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.skewSec = opts.refreshSkewSec ?? 30;
    const problems: string[] = [];
    for (const [name, config] of Object.entries(opts.schemes)) {
      const info = opts.schemeInfo[name];
      if (!info) {
        problems.push(`${name}: not a security scheme in the OpenAPI document`);
        continue;
      }
      if (!info.supported) {
        problems.push(`${name}: ${info.unsupportedReason}`);
        continue;
      }
      try {
        this.resolved.set(name, this._resolve(name, info, config));
      } catch (err) {
        problems.push(`${name}: ${(err as Error).message}`);
      }
    }
    if (problems.length > 0) {
      opts.logs.audit(
        "credential.config_invalid",
        "failure",
        { provider: this.id, problems: problems.map((p) => p.split(":")[0]) },
        "error",
      );
      throw new OagMcpError(
        "UPSTREAM_AUTH_CONFIG_INVALID",
        `Invalid upstreamAuth configuration: ${problems.join("; ")}`,
        { hint: "See docs/authentication.md#upstream-api-authentication." },
      );
    }
    opts.logs.audit("credential.provider.configured", "success", {
      provider: this.id,
      schemes: [...this.resolved.keys()],
      sharedIdentity: true,
    });
  }

  /**
   * Resolve configured secrets for one scheme.
   *
   * @private
   */
  private _resolve(
    name: string,
    info: SecuritySchemeInfo,
    config: UpstreamSchemeConfig,
  ): ResolvedScheme {
    const r = this.opts.resolver;
    const reg = this.opts.registry;
    const need = (field: keyof UpstreamSchemeConfig) => {
      const ref = config[field];
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
        throw new Error(`missing "${String(field)}" for ${info.type} scheme`);
      }
      const v = r.resolve(ref as never, `${name}.${String(field)}`);
      reg.add(v);
      return v;
    };
    const out: ResolvedScheme = { info, config };
    if (info.type === "apiKey") {
      out.apiKey = need("apiKey");
    } else if (info.type === "http" && info.scheme === "basic") {
      out.username = need("username");
      out.password = need("password");
      reg.add(`${out.username}:${out.password}`);
    } else if (info.type === "http" && info.scheme === "bearer") {
      out.token = need("token");
    } else if (info.type === "oauth2") {
      out.clientId = need("clientId");
      out.clientSecret = need("clientSecret");
      reg.add(`${out.clientId}:${out.clientSecret}`);
      const tokenUrl = new URL(
        config.tokenUrl ?? info.tokenUrl ?? "",
        this.opts.baseUrl,
      );
      if (!_secureUrl(tokenUrl) && !this.opts.allowInsecureTokenUrl) {
        throw new Error(
          `token URL ${tokenUrl.origin} is not HTTPS (set upstreamAuth.allowInsecureTokenUrl only for local testing)`,
        );
      }
      out.tokenUrl = tokenUrl.toString();
    }
    return out;
  }

  /** @inheritdoc */
  has(schemeName: string): boolean {
    return this.resolved.has(schemeName);
  }

  /** @inheritdoc */
  async apply(
    scheme: SecuritySchemeInfo,
    scopes: string[],
    ctx: CredentialContext,
  ): Promise<AppliedCredential> {
    const r = this.resolved.get(scheme.name);
    if (!r) {
      throw new UpstreamAuthError(
        "credential_not_configured",
        `No upstream credentials are configured for security scheme "${scheme.name}"`,
      );
    }
    const out: AppliedCredential = { headers: {}, query: {} };
    if (scheme.type === "apiKey") {
      if (scheme.in === "header") {
        out.headers[scheme.paramName!] = r.apiKey!;
      } else {
        out.query[scheme.paramName!] = r.apiKey!;
      }
    } else if (scheme.type === "http" && scheme.scheme === "basic") {
      out.headers.Authorization = `Basic ${Buffer.from(`${r.username}:${r.password}`).toString("base64")}`;
    } else if (scheme.type === "http" && scheme.scheme === "bearer") {
      out.headers.Authorization = `Bearer ${r.token}`;
    } else if (scheme.type === "oauth2") {
      const token = await this._clientCredentialsToken(r, scopes, ctx);
      out.headers.Authorization = `Bearer ${token}`;
    }
    return out;
  }

  /**
   * Cache key for a token request.
   *
   * @private
   */
  private _key(scheme: string, scopes: string[]): string {
    return `${scheme} ${[...scopes].sort().join(" ")}`;
  }

  /**
   * Obtain an OAuth2 client credentials token, reusing a cached token until
   * shortly before expiry and de-duplicating concurrent refreshes.
   *
   * @private
   */
  private async _clientCredentialsToken(
    r: ResolvedScheme,
    requiredScopes: string[],
    ctx: CredentialContext,
  ): Promise<string> {
    const scopes = r.config.scopes ?? requiredScopes;
    const key = this._key(r.info.name, scopes);
    const now = Date.now() / 1000;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.skewSec > now) {
      ctx.logs.op("debug", "upstream.token.cache_hit", {
        scheme: r.info.name,
      });
      return cached.token;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this._requestToken(r, scopes, ctx, Boolean(cached)).finally(
        () => this.inflight.delete(key),
      );
      this.inflight.set(key, pending);
    }
    const fresh = await pending;
    return fresh.token;
  }

  /**
   * Request a token from the token endpoint.
   *
   * @private
   */
  private async _requestToken(
    r: ResolvedScheme,
    scopes: string[],
    ctx: CredentialContext,
    isRefresh: boolean,
  ): Promise<CachedToken> {
    const started = Date.now();
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (scopes.length > 0) {
      body.set("scope", scopes.join(" "));
    }
    if (r.config.audience) {
      body.set("audience", r.config.audience);
    }
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (
      (r.config.clientAuthMethod ?? "client_secret_basic") ===
      "client_secret_basic"
    ) {
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(r.clientId!)}:${encodeURIComponent(r.clientSecret!)}`,
      ).toString("base64")}`;
    } else {
      body.set("client_id", r.clientId!);
      body.set("client_secret", r.clientSecret!);
    }
    const event = isRefresh ? "upstream.token.refresh" : "upstream.token.issue";
    let res: Response;
    try {
      res = await this.fetchImpl(r.tokenUrl!, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: ctx.signal,
      });
    } catch (err) {
      ctx.logs.audit(
        `${event}_failed`,
        "failure",
        {
          scheme: r.info.name,
          provider: this.id,
          reason: "token_endpoint_unreachable",
          error: sanitizeError(err).name,
        },
        "warn",
      );
      throw new UpstreamAuthError(
        "token_endpoint_unreachable",
        `Could not reach the OAuth2 token endpoint for "${r.info.name}"`,
      );
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // handled below
    }
    const token =
      typeof json.access_token === "string" ? json.access_token : "";
    const tokenType = String(json.token_type ?? "bearer").toLowerCase();
    if (!res.ok || !token || tokenType !== "bearer") {
      ctx.logs.audit(
        `${event}_failed`,
        "failure",
        {
          scheme: r.info.name,
          provider: this.id,
          status: res.status,
          reason: !res.ok
            ? "token_endpoint_error"
            : !token
              ? "no_access_token"
              : "unsupported_token_type",
          oauthError:
            typeof json.error === "string"
              ? json.error.slice(0, 64)
              : undefined,
        },
        "warn",
      );
      throw new UpstreamAuthError(
        "token_request_failed",
        `The OAuth2 token endpoint rejected the client credentials request for "${r.info.name}" (HTTP ${res.status})`,
      );
    }
    this.opts.registry.add(token);
    const expiresIn =
      typeof json.expires_in === "number" && json.expires_in > 0
        ? json.expires_in
        : 300;
    const entry = { token, expiresAt: Date.now() / 1000 + expiresIn };
    const previous = this.cache.get(this._key(r.info.name, scopes));
    this.cache.set(this._key(r.info.name, scopes), entry);
    ctx.logs.audit(event, "success", {
      scheme: r.info.name,
      provider: this.id,
      expiresInSec: expiresIn,
      scopeCount: scopes.length,
      durationMs: Date.now() - started,
    });
    if (previous) {
      // Keep scrubbing the previous token briefly; in-flight errors may echo it.
      setTimeout(
        () => this.opts.registry.remove(previous.token),
        60000,
      ).unref();
    }
    return entry;
  }

  /** @inheritdoc */
  invalidate(schemeName: string, ctx: CredentialContext): void {
    let removed = 0;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${schemeName} `)) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      ctx.logs.audit("upstream.token.invalidated", "success", {
        scheme: schemeName,
        provider: this.id,
        reason: "upstream_rejected_credentials",
      });
    }
  }
}
