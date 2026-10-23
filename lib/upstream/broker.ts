"use strict";
/**
 * Trusted host-side request broker.
 *
 * Every HTTP request made by the sandboxed SDK arrives here as a bridge
 * message tagged with the SDK binding that issued it. Before anything is
 * sent upstream the broker:
 *
 * 1. authorises the operation for the request principal (audited);
 * 2. checks the request matches that operation (method and path template)
 *    and targets the configured base URL (network policy);
 * 3. strips agent-supplied credential headers and query parameters;
 * 4. resolves the operation's security requirement into credentials;
 * 5. performs the request with manual redirect handling, following only
 *    permitted redirects and never forwarding credentials cross-origin;
 * 6. bounds the response size and removes Set-Cookie headers.
 *
 * @module upstream/broker
 */
import type { AuthorizationPolicy } from "../auth/policy.js";
import type {
  BridgeFetchRequest,
  BridgeFetchResult,
  ExecutionError,
} from "../executor/types.js";
import type { Logs } from "../logging/logger.js";
import { sanitizeError } from "../logging/redact.js";
import type {
  OperationBinding,
  Principal,
  SecuritySchemeInfo,
} from "../types.js";
import { UpstreamAuthError } from "./credentials.js";
import type { CredentialProvider } from "./types.js";
import { resolveSecurity } from "./security.js";

/** Network and size policy for upstream calls. */
export interface NetworkPolicy {
  baseUrl: string;
  /** Extra origins redirects may target (credentials are not forwarded). */
  allowedOrigins: string[];
  followRedirects: boolean;
  maxRedirects: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRequestBytes: number;
}

/** Per-execution context for the broker. */
export interface BrokerContext {
  principal: Principal;
  executionId: string;
  requestId?: string;
  logs: Logs;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
  "proxy-connection",
]);
const ALWAYS_STRIPPED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);
const RESPONSE_STRIPPED = new Set(["set-cookie", "set-cookie2"]);

/**
 * Compile a path template into a regular expression over URL paths.
 *
 * @param {String} basePath - base URL path without trailing slash
 * @param {String} template - OpenAPI path template
 * @return {RegExp} matcher
 */
export function compilePathTemplate(
  basePath: string,
  template: string,
): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "[^/]+" : escape(part)));
  return new RegExp(`^${escape(basePath)}${parts.join("")}/?$`);
}

/**
 * Host-side broker for sandboxed SDK requests.
 */
export class RequestBroker {
  private readonly ops = new Map<
    string,
    { op: OperationBinding; re: RegExp }
  >();
  private readonly base: URL;
  private readonly basePath: string;
  private readonly allowedOrigins: Set<string>;
  private readonly credentialNames: {
    headers: Set<string>;
    query: Set<string>;
  };

  /**
   * @param {Object} opts - broker options
   */
  constructor(
    private readonly opts: {
      operations: OperationBinding[];
      schemes: Record<string, SecuritySchemeInfo>;
      provider: CredentialProvider;
      policy: AuthorizationPolicy;
      network: NetworkPolicy;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.base = new URL(opts.network.baseUrl);
    this.basePath = this.base.pathname.replace(/\/+$/, "");
    for (const op of opts.operations) {
      this.ops.set(op.id, {
        op,
        re: compilePathTemplate(this.basePath, op.path),
      });
    }
    this.allowedOrigins = new Set([
      this.base.origin,
      ...opts.network.allowedOrigins.map((o) => new URL(o).origin),
    ]);
    const headers = new Set<string>();
    const query = new Set<string>();
    for (const s of Object.values(opts.schemes)) {
      if (s.type === "apiKey" && s.paramName) {
        (s.in === "query" ? query : headers).add(s.paramName.toLowerCase());
      }
    }
    this.credentialNames = { headers, query };
  }

  /** Base path the sandboxed SDK must use. */
  get sdkBasePath(): string {
    return `${this.base.origin}${this.basePath}`;
  }

  /**
   * Build an error result.
   *
   * @private
   */
  private _err(error: ExecutionError): BridgeFetchResult {
    return { ok: false, error };
  }

  /**
   * Handle one bridge fetch.
   *
   * @param {Object} req - bridge request
   * @param {Object} ctx - broker context
   * @param {AbortSignal} signal - aborted when the execution ends
   * @return {Promise} bridge result
   */
  async handle(
    req: BridgeFetchRequest,
    ctx: BrokerContext,
    signal: AbortSignal,
  ): Promise<BridgeFetchResult> {
    const logs = ctx.logs;
    const entry = this.ops.get(req.binding);
    if (!entry) {
      logs.audit(
        "execution.boundary_violation",
        "denied",
        {
          reason: "unknown_binding",
          binding: String(req.binding).slice(0, 120),
        },
        "warn",
      );
      return this._err({
        type: "permission_denied",
        reason: "unknown_binding",
        message: "Request did not come from a known SDK binding",
      });
    }
    const { op, re } = entry;

    // 1. Authorisation, for every attempted SDK operation.
    const decision = this.opts.policy.decide(ctx.principal, op);
    logs.audit(
      decision.allowed ? "authorization.allowed" : "authorization.denied",
      decision.allowed ? "allowed" : "denied",
      {
        operation: op.id,
        operationId: op.operationId,
        policyId: decision.policyId,
        reason: decision.reason,
      },
      decision.allowed ? "info" : "warn",
    );
    if (!decision.allowed) {
      return this._err({
        type: "permission_denied",
        reason: "authorization_denied",
        operation: op.id,
        message: `You are not permitted to call ${op.id}`,
      });
    }

    // 2. Request must match the operation and the configured base URL.
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return this._err({
        type: "permission_denied",
        reason: "invalid_url",
        message: "Invalid request URL",
      });
    }
    const method = String(req.method).toUpperCase();
    if (
      url.origin !== this.base.origin ||
      !re.test(url.pathname) ||
      method !== op.httpMethod ||
      url.username ||
      url.password
    ) {
      logs.audit(
        "network.destination_denied",
        "denied",
        {
          operation: op.id,
          reason:
            url.origin !== this.base.origin
              ? "origin_not_allowed"
              : method !== op.httpMethod
                ? "method_mismatch"
                : "path_mismatch",
          destinationOrigin: url.origin,
        },
        "warn",
      );
      return this._err({
        type: "permission_denied",
        reason: "network_destination_denied",
        operation: op.id,
        message: `Request to ${url.origin} does not match ${op.httpMethod} ${op.path} on the configured API base URL`,
      });
    }

    // 3. Strip agent-supplied credentials and hop-by-hop headers.
    const headers: Record<string, string> = {};
    const stripped: string[] = [];
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lk = k.toLowerCase();
      if (ALWAYS_STRIPPED.has(lk) || this.credentialNames.headers.has(lk)) {
        stripped.push(lk);
        continue;
      }
      if (HOP_BY_HOP.has(lk)) {
        continue;
      }
      headers[k] = String(v);
    }
    for (const name of [...url.searchParams.keys()]) {
      if (this.credentialNames.query.has(name.toLowerCase())) {
        url.searchParams.delete(name);
        stripped.push(`query:${name}`);
      }
    }
    if (stripped.length > 0) {
      logs.audit(
        "credential.agent_supplied_stripped",
        "denied",
        { operation: op.id, fields: stripped.slice(0, 10) },
        "warn",
      );
    }

    // 4. Credentials.
    let applied;
    try {
      applied = await resolveSecurity(
        op.security,
        this.opts.schemes,
        this.opts.provider,
        {
          principal: ctx.principal,
          operation: op,
          executionId: ctx.executionId,
          requestId: ctx.requestId,
          logs,
          signal,
        },
      );
      logs.audit("credential.resolved", "success", {
        operation: op.id,
        provider: this.opts.provider.id,
        schemes: applied.schemes,
        unauthenticated: applied.schemes.length === 0,
      });
    } catch (err) {
      const reason =
        err instanceof UpstreamAuthError ? err.reason : "credential_error";
      logs.audit(
        "credential.lookup_failed",
        "failure",
        { operation: op.id, provider: this.opts.provider.id, reason },
        "warn",
      );
      return this._err({
        type: "upstream_auth_error",
        reason,
        operation: op.id,
        message:
          err instanceof UpstreamAuthError
            ? err.message
            : "Upstream credentials are unavailable",
      });
    }
    for (const [k, v] of Object.entries(applied.query)) {
      url.searchParams.set(k, v);
    }
    Object.assign(headers, applied.headers);

    // 5. Body.
    let body: Uint8Array | string | undefined;
    if (req.body !== null && req.body !== undefined) {
      body =
        req.bodyEncoding === "base64"
          ? Buffer.from(req.body, "base64")
          : req.body;
      const size =
        typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
      if (size > this.opts.network.maxRequestBytes) {
        logs.audit(
          "execution.resource_limit",
          "denied",
          {
            operation: op.id,
            limit: "maxRequestBytes",
            value: this.opts.network.maxRequestBytes,
          },
          "warn",
        );
        return this._err({
          type: "resource_limit",
          reason: "request_too_large",
          message: `Request body exceeds ${this.opts.network.maxRequestBytes} bytes`,
        });
      }
    }

    // 6. Send, with manual redirects.
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.opts.network.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = headers;
    let res: Response | undefined;
    try {
      for (let hop = 0; ; hop++) {
        res = await fetchImpl(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody as RequestInit["body"],
          redirect: "manual",
          signal: combined,
        });
        if (![301, 302, 303, 307, 308].includes(res.status)) {
          break;
        }
        const location = res.headers.get("location");
        if (!location) {
          break;
        }
        const next = new URL(location, currentUrl);
        const allowed =
          this.opts.network.followRedirects &&
          hop < this.opts.network.maxRedirects &&
          (next.protocol === "https:" || next.protocol === "http:") &&
          this.allowedOrigins.has(next.origin);
        if (!allowed) {
          await res.body?.cancel();
          logs.audit(
            "network.redirect_denied",
            "denied",
            {
              operation: op.id,
              destinationOrigin: next.origin,
              reason: !this.opts.network.followRedirects
                ? "redirects_disabled"
                : hop >= this.opts.network.maxRedirects
                  ? "too_many_redirects"
                  : "origin_not_allowed",
            },
            "warn",
          );
          return this._err({
            type: "permission_denied",
            reason: "redirect_denied",
            operation: op.id,
            message: `The API redirected to ${next.origin}, which the network policy does not allow`,
          });
        }
        await res.body?.cancel();
        logs.op("debug", "upstream.call.redirected", {
          operation: op.id,
          status: res.status,
          sameOrigin: next.origin === this.base.origin,
        });
        if (next.origin !== this.base.origin) {
          // Never forward credentials to another origin.
          currentHeaders = Object.fromEntries(
            Object.entries(currentHeaders).filter(
              ([k]) =>
                !ALWAYS_STRIPPED.has(k.toLowerCase()) &&
                !this.credentialNames.headers.has(k.toLowerCase()),
            ),
          );
          for (const name of Object.keys(applied.query)) {
            next.searchParams.delete(name);
          }
        }
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) &&
            currentMethod === "POST")
        ) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        currentUrl = next;
      }
    } catch (err) {
      const timedOut = timeout.aborted && !signal.aborted;
      logs.op("warn", "upstream.call.failed", {
        operation: op.id,
        httpMethod: op.httpMethod,
        pathTemplate: op.path,
        durationMs: Date.now() - started,
        reason: timedOut
          ? "timeout"
          : signal.aborted
            ? "execution_ended"
            : "network_error",
        error: sanitizeError(err).name,
      });
      return this._err({
        type: "upstream_unreachable",
        reason: timedOut ? "upstream_timeout" : "network_error",
        operation: op.id,
        message: timedOut
          ? `The API did not respond within ${this.opts.network.timeoutMs} ms`
          : "The API could not be reached",
      });
    }
    const response = res!;
    if (response.status === 401) {
      for (const s of applied.schemes) {
        if (this.opts.schemes[s]?.type === "oauth2") {
          this.opts.provider.invalidate(s, {
            principal: ctx.principal,
            operation: op,
            logs,
          });
        }
      }
    }

    // 7. Bounded response.
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > this.opts.network.maxResponseBytes) {
          await reader.cancel();
          logs.audit(
            "execution.resource_limit",
            "denied",
            {
              operation: op.id,
              limit: "maxResponseBytes",
              value: this.opts.network.maxResponseBytes,
            },
            "warn",
          );
          return this._err({
            type: "resource_limit",
            reason: "response_too_large",
            operation: op.id,
            message: `The API response exceeded ${this.opts.network.maxResponseBytes} bytes`,
          });
        }
        chunks.push(value);
      }
    }
    const outHeaders: Array<[string, string]> = [];
    response.headers.forEach((v, k) => {
      if (!RESPONSE_STRIPPED.has(k.toLowerCase())) {
        outHeaders.push([k, v]);
      }
    });
    logs.op("info", "upstream.call.completed", {
      operation: op.id,
      httpMethod: op.httpMethod,
      pathTemplate: op.path,
      status: response.status,
      durationMs: Date.now() - started,
      responseBytes: total,
      outcome: response.ok ? "success" : "failure",
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
      body: Buffer.concat(chunks).toString("base64"),
    };
  }
}
