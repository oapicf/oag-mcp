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
import type { AuthorizationPolicy } from "../server/authorization.js";
import type {
  BridgeFetchRequest,
  BridgeFetchResult,
  ExecutionError,
} from "../executor/types.js";
import type { Logs } from "../logging/logger.js";
import { sanitizeError } from "../util/redact.js";
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
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A refused request: the bridge result returned to the sandbox. */
type Refusal = Extract<BridgeFetchResult, { ok: false }>;

/** The authorisation policy's decision for an allowed operation. */
type Decision = ReturnType<AuthorizationPolicy["decide"]>;

/** Credentials resolved for an operation's security requirement. */
type AppliedSecurity = Awaited<ReturnType<typeof resolveSecurity>>;

/** A request body, decoded. */
type Body = Uint8Array | string | undefined;

/** One SDK operation call as it moves through the broker's steps. */
interface Call {
  op: OperationBinding;
  /** The operation's path template as a URL path matcher. */
  re: RegExp;
  ctx: BrokerContext;
  signal: AbortSignal;
  /** Fields identifying the operation in audit records. */
  audit: {
    operation: string;
    operationId?: string;
    httpMethod: string;
    pathTemplate: string;
  };
}

/** Where the request goes, once checked. */
interface Target {
  url: URL;
  method: string;
  /** Request headers, set once credentials are applied. */
  headers?: Record<string, string>;
}

/** Request headers without agent-supplied credentials. */
interface Stripped {
  headers: Record<string, string>;
  /** Names of the credential headers and query parameters removed. */
  names: string[];
}

/** A response received from the API. */
interface Sent {
  response: Response;
  /** When the request was first sent, in milliseconds. */
  started: number;
}

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
  private _err(error: ExecutionError): Refusal {
    return { ok: false, error };
  }

  /**
   * Handle one bridge fetch: each step either passes its result on or
   * refuses the request.
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
    const call = this._call(req, ctx, signal);
    if (_refused(call)) {
      return call;
    }
    const decision = this._authorize(call);
    if (_refused(decision)) {
      return decision;
    }
    const target = this._destination(call, req);
    if (_refused(target)) {
      return target;
    }
    const stripped = this._stripCredentials(req, target);
    const applied = await this._applyCredentials(
      call,
      decision,
      target,
      stripped,
    );
    if (_refused(applied)) {
      return applied;
    }
    const body = this._body(call, req);
    if (_refused(body)) {
      return body;
    }
    const sent = await this._send(call, { ...target, body }, applied);
    if (_refused(sent)) {
      return sent;
    }
    this._invalidateRejected(call, sent.response, applied);
    return this._readResponse(call, sent);
  }

  /**
   * Find the operation of the SDK binding that sent the request. An unknown
   * binding can only come from agent code writing bridge messages itself.
   *
   * @private
   */
  private _call(
    req: BridgeFetchRequest,
    ctx: BrokerContext,
    signal: AbortSignal,
  ): Call | Refusal {
    const entry = this.ops.get(req.binding);
    if (!entry) {
      ctx.logs.audit(
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
    return {
      op,
      re,
      ctx,
      signal,
      audit: {
        operation: op.id,
        operationId: op.operationId,
        httpMethod: op.httpMethod,
        pathTemplate: op.path,
      },
    };
  }

  /**
   * Step 1: authorise the operation, for every attempted SDK operation.
   *
   * Each attempt gets exactly one decision record: denied here, a denied
   * destination or a credential failure in a later step, or allowed once
   * credentials are applied.
   *
   * @private
   */
  private _authorize(call: Call): Decision | Refusal {
    const decision = this.opts.policy.decide(call.ctx.principal, call.op);
    if (decision.allowed) {
      return decision;
    }
    call.ctx.logs.audit(
      "authorization.denied",
      "denied",
      {
        ...call.audit,
        policyId: decision.policyId,
        reason: decision.reason,
      },
      "warn",
    );
    return this._err({
      type: "permission_denied",
      reason: "authorization_denied",
      operation: call.op.id,
      message: `You are not permitted to call ${call.op.id}`,
    });
  }

  /**
   * Step 2: the request must match the operation (method and path template)
   * and target the configured base URL.
   *
   * @private
   */
  private _destination(call: Call, req: BridgeFetchRequest): Target | Refusal {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      call.ctx.logs.audit(
        "network.destination_denied",
        "denied",
        { ...call.audit, reason: "invalid_url" },
        "warn",
      );
      return this._err({
        type: "permission_denied",
        reason: "invalid_url",
        message: "Invalid request URL",
      });
    }
    const method = String(req.method).toUpperCase();
    const reason = this._destinationMismatch(call, url, method);
    if (!reason) {
      return { url, method };
    }
    call.ctx.logs.audit(
      "network.destination_denied",
      "denied",
      {
        operation: call.op.id,
        httpMethod: method,
        pathTemplate: call.op.path,
        reason,
        destinationOrigin: url.origin,
      },
      "warn",
    );
    return this._err({
      type: "permission_denied",
      reason: "network_destination_denied",
      operation: call.op.id,
      message: `Request to ${url.origin} does not match ${call.op.httpMethod} ${call.op.path} on the configured API base URL`,
    });
  }

  /**
   * Why a request does not match its operation, or undefined when it does.
   * A URL with user info never matches.
   *
   * @private
   */
  private _destinationMismatch(
    call: Call,
    url: URL,
    method: string,
  ): string | undefined {
    if (url.origin !== this.base.origin) {
      return "origin_not_allowed";
    }
    if (method !== call.op.httpMethod) {
      return "method_mismatch";
    }
    if (!call.re.test(url.pathname) || url.username || url.password) {
      return "path_mismatch";
    }
    return undefined;
  }

  /**
   * Step 3: drop agent-supplied credentials (headers and query parameters)
   * and hop-by-hop headers. The URL's credential query parameters are
   * removed in place.
   *
   * @private
   */
  private _stripCredentials(req: BridgeFetchRequest, target: Target): Stripped {
    const headers: Record<string, string> = {};
    const names: string[] = [];
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lk = k.toLowerCase();
      if (this._isCredentialHeader(lk)) {
        names.push(lk);
      } else if (!HOP_BY_HOP.has(lk)) {
        headers[k] = String(v);
      }
    }
    for (const name of [...target.url.searchParams.keys()]) {
      if (this.credentialNames.query.has(name.toLowerCase())) {
        target.url.searchParams.delete(name);
        names.push(`query:${name}`);
      }
    }
    return { headers, names };
  }

  /**
   * Whether a (lower-case) header name carries credentials.
   *
   * @private
   */
  private _isCredentialHeader(name: string): boolean {
    return ALWAYS_STRIPPED.has(name) || this.credentialNames.headers.has(name);
  }

  /**
   * Step 4: resolve the operation's security requirement into credentials,
   * record the allowed decision and apply the credentials to the request.
   *
   * @private
   */
  private async _applyCredentials(
    call: Call,
    decision: Decision,
    target: Target,
    stripped: Stripped,
  ): Promise<AppliedSecurity | Refusal> {
    const { ctx, op } = call;
    const strippedCredentials =
      stripped.names.length > 0
        ? { strippedCredentials: stripped.names.slice(0, 10) }
        : {};
    let applied: AppliedSecurity;
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
          logs: ctx.logs,
          signal: call.signal,
        },
      );
    } catch (err) {
      const auth = err instanceof UpstreamAuthError ? err : undefined;
      const reason = auth?.reason ?? "credential_error";
      ctx.logs.audit(
        "credential.lookup_failed",
        "failure",
        {
          ...call.audit,
          ...strippedCredentials,
          provider: this.opts.provider.id,
          reason,
        },
        "warn",
      );
      return this._err({
        type: "upstream_auth_error",
        reason,
        operation: op.id,
        message: auth?.message ?? "Upstream credentials are unavailable",
      });
    }
    ctx.logs.audit(
      "authorization.allowed",
      "allowed",
      {
        ...call.audit,
        ...strippedCredentials,
        policyId: decision.policyId,
        reason: decision.reason,
        provider: this.opts.provider.id,
        schemes: applied.schemes,
        unauthenticated: applied.schemes.length === 0,
      },
      stripped.names.length > 0 ? "warn" : "info",
    );
    for (const [k, v] of Object.entries(applied.query)) {
      target.url.searchParams.set(k, v);
    }
    Object.assign(stripped.headers, applied.headers);
    target.headers = stripped.headers;
    return applied;
  }

  /**
   * Step 5: decode the request body and enforce its size limit.
   *
   * @private
   */
  private _body(call: Call, req: BridgeFetchRequest): Body | Refusal {
    if (req.body === null || req.body === undefined) {
      return undefined;
    }
    const body =
      req.bodyEncoding === "base64"
        ? Buffer.from(req.body, "base64")
        : req.body;
    const size =
      typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    const limit = this.opts.network.maxRequestBytes;
    if (size <= limit) {
      return body;
    }
    call.ctx.logs.audit(
      "execution.resource_limit",
      "denied",
      { ...call.audit, limit: "maxRequestBytes", value: limit },
      "warn",
    );
    return this._err({
      type: "resource_limit",
      reason: "request_too_large",
      message: `Request body exceeds ${limit} bytes`,
    });
  }

  /**
   * Step 6: send the request, following only redirects the network policy
   * permits, within the upstream timeout.
   *
   * @private
   */
  private async _send(
    call: Call,
    request: Target & { body: Body },
    applied: AppliedSecurity,
  ): Promise<Sent | Refusal> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.opts.network.timeoutMs);
    const signal = AbortSignal.any([call.signal, timeout]);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const current = { ...request };
    try {
      for (let hop = 0; ; hop++) {
        const response = await fetchImpl(current.url, {
          method: current.method,
          headers: current.headers,
          body: current.body as RequestInit["body"],
          redirect: "manual",
          signal,
        });
        const next = _redirectLocation(response, current.url);
        if (!next) {
          return { response, started };
        }
        await response.body?.cancel();
        const refused = this._checkRedirect(call, next, hop, current.method);
        if (refused) {
          return refused;
        }
        this._followRedirect(call, current, response.status, next, applied);
      }
    } catch (err) {
      return this._unreachable(call, err, timeout, started);
    }
  }

  /**
   * Refuse a redirect the network policy does not permit.
   *
   * @private
   */
  private _checkRedirect(
    call: Call,
    next: URL,
    hop: number,
    method: string,
  ): Refusal | undefined {
    const network = this.opts.network;
    const reason = !network.followRedirects
      ? "redirects_disabled"
      : hop >= network.maxRedirects
        ? "too_many_redirects"
        : !/^https?:$/.test(next.protocol) ||
            !this.allowedOrigins.has(next.origin)
          ? "origin_not_allowed"
          : undefined;
    if (!reason) {
      return undefined;
    }
    call.ctx.logs.audit(
      "network.redirect_denied",
      "denied",
      {
        operation: call.op.id,
        httpMethod: method,
        pathTemplate: call.op.path,
        destinationOrigin: next.origin,
        reason,
      },
      "warn",
    );
    return this._err({
      type: "permission_denied",
      reason: "redirect_denied",
      operation: call.op.id,
      message: `The API redirected to ${next.origin}, which the network policy does not allow`,
    });
  }

  /**
   * Prepare the request for a permitted redirect: never forward credentials
   * to another origin, and turn the request into a GET where HTTP says so.
   *
   * @private
   */
  private _followRedirect(
    call: Call,
    current: Target & { body: Body },
    status: number,
    next: URL,
    applied: AppliedSecurity,
  ): void {
    call.ctx.logs.op("debug", "upstream.call.redirected", {
      operation: call.op.id,
      status,
      sameOrigin: next.origin === this.base.origin,
    });
    if (next.origin !== this.base.origin) {
      current.headers = Object.fromEntries(
        Object.entries(current.headers ?? {}).filter(
          ([k]) => !this._isCredentialHeader(k.toLowerCase()),
        ),
      );
      for (const name of Object.keys(applied.query)) {
        next.searchParams.delete(name);
      }
    }
    if (
      status === 303 ||
      ((status === 301 || status === 302) && current.method === "POST")
    ) {
      current.method = "GET";
      current.body = undefined;
    }
    current.url = next;
  }

  /**
   * Report a request that failed before any response: timeout, end of the
   * execution, or a network error.
   *
   * @private
   */
  private _unreachable(
    call: Call,
    err: unknown,
    timeout: AbortSignal,
    started: number,
  ): Refusal {
    const timedOut = timeout.aborted && !call.signal.aborted;
    call.ctx.logs.op("warn", "upstream.call.failed", {
      operation: call.op.id,
      httpMethod: call.op.httpMethod,
      pathTemplate: call.op.path,
      durationMs: Date.now() - started,
      reason: timedOut
        ? "timeout"
        : call.signal.aborted
          ? "execution_ended"
          : "network_error",
      error: sanitizeError(err).name,
    });
    return this._err({
      type: "upstream_unreachable",
      reason: timedOut ? "upstream_timeout" : "network_error",
      operation: call.op.id,
      message: timedOut
        ? `The API did not respond within ${this.opts.network.timeoutMs} ms`
        : "The API could not be reached",
    });
  }

  /**
   * Discard cached OAuth tokens the API rejected, so the next call obtains
   * a new one.
   *
   * @private
   */
  private _invalidateRejected(
    call: Call,
    response: Response,
    applied: AppliedSecurity,
  ): void {
    if (response.status !== 401) {
      return;
    }
    for (const s of applied.schemes) {
      if (this.opts.schemes[s]?.type === "oauth2") {
        this.opts.provider.invalidate(s, {
          principal: call.ctx.principal,
          operation: call.op,
          logs: call.ctx.logs,
        });
      }
    }
  }

  /**
   * Step 7: read the response within its size limit, without Set-Cookie
   * headers.
   *
   * @private
   */
  private async _readResponse(
    call: Call,
    sent: Sent,
  ): Promise<BridgeFetchResult> {
    const { response, started } = sent;
    const body = await this._readBody(call, response);
    if (_refused(body)) {
      return body;
    }
    const headers: Array<[string, string]> = [];
    response.headers.forEach((v, k) => {
      if (!RESPONSE_STRIPPED.has(k.toLowerCase())) {
        headers.push([k, v]);
      }
    });
    call.ctx.logs.op("info", "upstream.call.completed", {
      operation: call.op.id,
      httpMethod: call.op.httpMethod,
      pathTemplate: call.op.path,
      status: response.status,
      durationMs: Date.now() - started,
      responseBytes: body.byteLength,
      outcome: response.ok ? "success" : "failure",
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: body.toString("base64"),
    };
  }

  /**
   * Read a response body, refusing it once it exceeds the size limit.
   *
   * @private
   */
  private async _readBody(
    call: Call,
    response: Response,
  ): Promise<Buffer | Refusal> {
    const limit = this.opts.network.maxResponseBytes;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
      total += r.value.byteLength;
      if (total > limit) {
        await reader!.cancel();
        call.ctx.logs.audit(
          "execution.resource_limit",
          "denied",
          { ...call.audit, limit: "maxResponseBytes", value: limit },
          "warn",
        );
        return this._err({
          type: "resource_limit",
          reason: "response_too_large",
          operation: call.op.id,
          message: `The API response exceeded ${limit} bytes`,
        });
      }
      chunks.push(r.value);
    }
    return Buffer.concat(chunks);
  }
}

/**
 * The next URL of a redirect response, or undefined when the response is
 * not a redirect.
 *
 * @private
 */
function _redirectLocation(response: Response, current: URL): URL | undefined {
  if (!REDIRECT_STATUSES.has(response.status)) {
    return undefined;
  }
  const location = response.headers.get("location");
  return location ? new URL(location, current) : undefined;
}

/**
 * Whether a step refused the request.
 *
 * @private
 */
function _refused(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}
