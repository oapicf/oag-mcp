"use strict";
/**
 * Upstream API credential providers.
 *
 * A {@link CredentialProvider} (see upstream/types) turns an OpenAPI security scheme into
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
import type { UpstreamSchemeConfig } from "../config.js";
import type { SecretResolver } from "../util/secrets.js";
import { OagMcpError } from "../errors.js";
import type { Logs } from "../logger.js";
import { type SecretRegistry, sanitizeError } from "../util/redact.js";
import type { SecuritySchemeInfo } from "../types.js";
import type {
  AppliedCredential,
  CredentialContext,
  CredentialProvider,
} from "./types.js";

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

/** The supported ways of presenting a credential. */
type SchemeKind = "apiKey" | "basic" | "bearer" | "oauth2";

/** Configuration fields that hold secret references. */
type SecretField =
  "apiKey" | "username" | "password" | "token" | "clientId" | "clientSecret";

/** Audit events of a token request. */
type TokenEvent = "upstream.token.issue" | "upstream.token.refresh";

/** A client credentials token request. */
interface TokenForm {
  headers: Record<string, string>;
  body: URLSearchParams;
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
 * How a security scheme presents its credential, when it is supported.
 *
 * @private
 */
function _schemeKind(info: SecuritySchemeInfo): SchemeKind | undefined {
  if (info.type === "apiKey" || info.type === "oauth2") {
    return info.type;
  }
  if (
    info.type === "http" &&
    (info.scheme === "basic" || info.scheme === "bearer")
  ) {
    return info.scheme;
  }
  return undefined;
}

/**
 * The form and headers of a client credentials token request.
 *
 * @private
 */
function _tokenForm(r: ResolvedScheme, scopes: string[]): TokenForm {
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
  return { headers, body };
}

/**
 * A token response's JSON object; empty when the body is not one.
 *
 * @private
 */
async function _readTokenJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const json: unknown = await res.json();
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Why a token response is unusable, if it is.
 *
 * @private
 */
function _tokenRejection(
  res: Response,
  token: string,
  json: Record<string, unknown>,
): string | undefined {
  if (!res.ok) {
    return "token_endpoint_error";
  }
  if (!token) {
    return "no_access_token";
  }
  return String(json.token_type ?? "bearer").toLowerCase() === "bearer"
    ? undefined
    : "unsupported_token_type";
}

/**
 * The token lifetime in seconds, defaulting to five minutes.
 *
 * @private
 */
function _expiresIn(json: Record<string, unknown>): number {
  return typeof json.expires_in === "number" && json.expires_in > 0
    ? json.expires_in
    : 300;
}

/**
 * Single upstream service identity loaded from the configuration.
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
    const need = (field: SecretField) =>
      this._secret(name, info, config, field);
    const out: ResolvedScheme = { info, config };
    switch (_schemeKind(info)) {
      case "apiKey":
        out.apiKey = need("apiKey");
        break;
      case "basic":
        out.username = need("username");
        out.password = need("password");
        this.opts.registry.add(`${out.username}:${out.password}`);
        break;
      case "bearer":
        out.token = need("token");
        break;
      case "oauth2":
        out.clientId = need("clientId");
        out.clientSecret = need("clientSecret");
        this.opts.registry.add(`${out.clientId}:${out.clientSecret}`);
        out.tokenUrl = this._tokenUrl(info, config);
        break;
    }
    return out;
  }

  /**
   * Resolve one configured secret and register it for scrubbing.
   *
   * @private
   */
  private _secret(
    name: string,
    info: SecuritySchemeInfo,
    config: UpstreamSchemeConfig,
    field: SecretField,
  ): string {
    const ref = config[field];
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new Error(`missing "${field}" for ${info.type} scheme`);
    }
    const v = this.opts.resolver.resolve(ref, `${name}.${field}`);
    this.opts.registry.add(v);
    return v;
  }

  /**
   * The token endpoint, which must be HTTPS or loopback unless allowed.
   *
   * @private
   */
  private _tokenUrl(
    info: SecuritySchemeInfo,
    config: UpstreamSchemeConfig,
  ): string {
    const tokenUrl = new URL(
      config.tokenUrl ?? info.tokenUrl ?? "",
      this.opts.baseUrl,
    );
    if (!_secureUrl(tokenUrl) && !this.opts.allowInsecureTokenUrl) {
      throw new Error(
        `token URL ${tokenUrl.origin} is not HTTPS (set upstreamAuth.allowInsecureTokenUrl only for local testing)`,
      );
    }
    return tokenUrl.toString();
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
    switch (_schemeKind(scheme)) {
      case "apiKey":
        (scheme.in === "header" ? out.headers : out.query)[scheme.paramName!] =
          r.apiKey!;
        break;
      case "basic":
        out.headers.Authorization = `Basic ${Buffer.from(`${r.username}:${r.password}`).toString("base64")}`;
        break;
      case "bearer":
        out.headers.Authorization = `Bearer ${r.token}`;
        break;
      case "oauth2":
        out.headers.Authorization = `Bearer ${await this._clientCredentialsToken(r, scopes, ctx)}`;
        break;
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
    const event: TokenEvent = isRefresh
      ? "upstream.token.refresh"
      : "upstream.token.issue";
    const res = await this._postToken(r, scopes, ctx, event);
    const json = await _readTokenJson(res);
    const token =
      typeof json.access_token === "string" ? json.access_token : "";
    const reason = _tokenRejection(res, token, json);
    if (reason) {
      this._auditTokenFailure(r, ctx, event, {
        status: res.status,
        reason,
        oauthError:
          typeof json.error === "string" ? json.error.slice(0, 64) : undefined,
      });
      throw new UpstreamAuthError(
        "token_request_failed",
        `The OAuth2 token endpoint rejected the client credentials request for "${r.info.name}" (HTTP ${res.status})`,
      );
    }
    const expiresIn = _expiresIn(json);
    const entry = this._storeToken(r, scopes, token, expiresIn);
    ctx.logs.audit(event, "success", {
      scheme: r.info.name,
      provider: this.id,
      expiresInSec: expiresIn,
      scopeCount: scopes.length,
      durationMs: Date.now() - started,
    });
    return entry;
  }

  /**
   * POST the token request, failing clearly when the endpoint is unreachable.
   *
   * @private
   */
  private async _postToken(
    r: ResolvedScheme,
    scopes: string[],
    ctx: CredentialContext,
    event: TokenEvent,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(r.tokenUrl!, {
        method: "POST",
        ..._tokenForm(r, scopes),
        redirect: "error",
        signal: ctx.signal,
      });
    } catch (err) {
      this._auditTokenFailure(r, ctx, event, {
        reason: "token_endpoint_unreachable",
        error: sanitizeError(err).name,
      });
      throw new UpstreamAuthError(
        "token_endpoint_unreachable",
        `Could not reach the OAuth2 token endpoint for "${r.info.name}"`,
      );
    }
  }

  /**
   * Audit a failed token request.
   *
   * @private
   */
  private _auditTokenFailure(
    r: ResolvedScheme,
    ctx: CredentialContext,
    event: TokenEvent,
    fields: Record<string, unknown>,
  ): void {
    ctx.logs.audit(
      `${event}_failed`,
      "failure",
      { scheme: r.info.name, provider: this.id, ...fields },
      "warn",
    );
  }

  /**
   * Cache a fresh token, registering it for scrubbing.
   *
   * @private
   */
  private _storeToken(
    r: ResolvedScheme,
    scopes: string[],
    token: string,
    expiresIn: number,
  ): CachedToken {
    this.opts.registry.add(token);
    const entry = { token, expiresAt: Date.now() / 1000 + expiresIn };
    const key = this._key(r.info.name, scopes);
    const previous = this.cache.get(key);
    this.cache.set(key, entry);
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
