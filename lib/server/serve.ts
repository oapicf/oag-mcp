"use strict";
/**
 * `oag-mcp serve`: prepare an OpenAPI document and an existing
 * typescript-fetch SDK once, then serve them over stdio or Streamable HTTP.
 *
 * Start-up order: inputs → compatibility → SDK bundle/declarations → index
 * (prepare/prepare) → bridge and executor (server/service) → tool
 * registration → transport. No request is accepted until every stage has
 * succeeded; on any failure the private workspace is removed and the error
 * is returned (no partially functional server).
 *
 * stdio uses the local process/OS boundary for access control: the parent
 * process that spawned the server is the caller. stdout carries only MCP
 * protocol traffic; logs go to stderr or configured files.
 *
 * Streamable HTTP binds to loopback by default and authenticates every
 * protected request (see server/authentication). This is the 2025-03-26+ Streamable
 * HTTP transport, not the legacy HTTP+SSE transport.
 *
 * @module server/serve
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable, Writable } from "node:stream";

import {
  hostHeaderValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

import {
  type HttpAuthenticator,
  createHttpAuthenticator,
  isLoopbackHost,
} from "./authentication.js";
import { type Config, browserOrigin } from "../config.js";
import type { Executor } from "../executor/types.js";
import { SecretResolver } from "../util/secrets.js";
import { OagMcpError } from "../errors.js";
import type { Logs } from "../logging/logger.js";
import { secrets } from "../util/redact.js";
import {
  type PrepareOptions,
  type PreparedSdk,
  prepareSdk,
  runStage,
} from "../prepare/prepare.js";
import type { Principal } from "../types.js";
import { TOOL_NAMES, createMcpServer } from "./tools.js";
import { type ClientEndpoint, OagMcpService } from "./service.js";

/** A running server. */
export interface RunningServer {
  transport: "stdio" | "streamable-http";
  /** Bound URL for HTTP. */
  url?: string;
  close(): Promise<void>;
}

/** Options for {@link serve}. */
export interface ServeOptions extends Omit<PrepareOptions, "logs"> {
  transport: "stdio" | "streamable-http";
  config: Config;
  configBaseDir: string;
  logs: Logs;
  fetchImpl?: typeof fetch;
  /** Executor for agent code; default: a verified Deno subprocess executor. */
  executor?: Executor;
  /** Streams for the stdio transport; default: this process's. */
  stdio?: { stdin: Readable; stdout: Writable };
}

/** Node.js request handling for Streamable HTTP. */
type NodeHandler = ReturnType<typeof toNodeHandler>;

/** Validates one request, writing the refusal itself; false when refused. */
type RequestValidator = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => boolean;

/** Everything a Streamable HTTP request is routed with. */
interface HttpContext {
  h: Config["http"];
  logs: Logs;
  authenticator: HttpAuthenticator;
  nodeHandler: NodeHandler;
  validateHost: RequestValidator | undefined;
  validateOrigin: RequestValidator;
  resourceUrl: URL;
}

/** What identifies one HTTP request in records and in the MCP server. */
interface HttpRequestScope {
  requestId: string;
  client: ClientEndpoint;
  reqLogs: Logs;
}

/**
 * Prepare the SDK and start serving it.
 *
 * @param {Object} opts - serve options
 * @return {Promise} running server
 */
export async function serve(opts: ServeOptions): Promise<RunningServer> {
  const started = Date.now();
  return servePrepared(await prepareSdk(opts), opts, started);
}

/**
 * Serve an already prepared SDK. The prepared workspace is removed when
 * start-up fails or the server is closed.
 *
 * @param {Object} prepared - prepared SDK
 * @param {Object} opts - serve options
 * @param {Number} [started] - start-up start time, default: now
 * @return {Promise} running server
 */
export async function servePrepared(
  prepared: PreparedSdk,
  opts: ServeOptions,
  started: number = Date.now(),
): Promise<RunningServer> {
  const { config, logs } = opts;
  let running: RunningServer;
  try {
    const service = await runStage(
      logs,
      "executor",
      () =>
        OagMcpService.create({
          prepared,
          config,
          configBaseDir: opts.configBaseDir,
          logs,
          executor: opts.executor,
          fetchImpl: opts.fetchImpl,
        }),
      opts.signal,
    );
    logs.op("info", "tools.registered", {
      tools: TOOL_NAMES,
      methods: prepared.records.length,
    });
    if (opts.signal?.aborted) {
      throw new OagMcpError(
        "STARTUP_ABORTED",
        "Start-up was cancelled before the transport started",
        { hint: "The server received a shutdown signal while preparing." },
      );
    }
    service.warmUp();
    running =
      opts.transport === "stdio"
        ? _serveStdio(service, opts)
        : await _serveHttp(service, opts);
  } catch (err) {
    prepared.cleanup();
    throw err;
  }
  logs.op("info", "server.ready", {
    transport: running.transport,
    prepareId: prepared.info.prepareId,
    methods: prepared.records.length,
    startupDurationMs: Date.now() - started,
  });
  const close = running.close;
  let closed: Promise<void> | undefined;
  running.close = () => {
    closed ??= (async () => {
      try {
        await close();
      } finally {
        if (prepared.cleanup()) {
          logs.op("info", "prepare.workspace.cleaned", { outcome: "success" });
        }
        logs.op("info", "server.stopped", { transport: running.transport });
        logs.flush();
      }
    })();
    return closed;
  };
  return running;
}

/**
 * Serve over stdio.
 *
 * @private
 */
function _serveStdio(
  service: OagMcpService,
  opts: ServeOptions,
): RunningServer {
  const { logs, config } = opts;
  const principal: Principal = {
    id: `local:${config.mcpAuth.stdio.principal}`,
    kind: "local",
    name: config.mcpAuth.stdio.principal,
    scopes: config.mcpAuth.stdio.scopes,
  };
  logs.audit("authentication.succeeded", "success", {
    mode: "stdio-process-boundary",
    principalId: principal.id,
    transport: "stdio",
  });
  const handle = serveStdio(
    () => createMcpServer(service, principal, "stdio"),
    {
      transport: new StdioServerTransport(
        opts.stdio?.stdin,
        opts.stdio?.stdout,
      ),
      onerror: (err) =>
        logs.op("error", "transport.error", {
          transport: "stdio",
          error: err.name,
        }),
    },
  );
  logs.op("info", "transport.initialized", {
    transport: "stdio",
    outcome: "success",
  });
  return {
    transport: "stdio",
    close: async () => {
      await handle.close();
    },
  };
}

/**
 * Refuse unauthenticated non-loopback binds; warn about remote exposure.
 *
 * @private
 */
function _checkExposure(config: Config, logs: Logs, loopback: boolean): void {
  const host = config.http.host;
  if (config.mcpAuth.mode === "none" && !loopback) {
    logs.audit(
      "security.unauthenticated_nonloopback_refused",
      "denied",
      { host, mode: "none" },
      "error",
    );
    throw new OagMcpError(
      "MCP_AUTH_REQUIRED",
      `Refusing to serve unauthenticated MCP on non-loopback address ${host}`,
      {
        hint: "Bind to 127.0.0.1, or configure mcpAuth.mode static-bearer or oauth. Terminate TLS in front of the server for remote access.",
      },
    );
  }
  if (!loopback) {
    logs.op("warn", "transport.remote_exposure", {
      host,
      note: "terminate HTTPS in a reverse proxy; oag-mcp serves plain HTTP",
    });
  }
}

/**
 * Start listening.
 *
 * @private
 */
function _listen(h: Config["http"]): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(h.port, h.host, () => resolve(server));
  });
}

/**
 * The URL a listening server serves the MCP endpoint at.
 *
 * @private
 */
function _localUrl(server: http.Server, h: Config["http"]): string {
  const listen = server.address() as AddressInfo;
  const host =
    listen.family === "IPv6" ? `[${listen.address}]` : listen.address;
  return `http://${host}:${listen.port}${h.path}`;
}

/**
 * Create the authenticator, auditing an invalid configuration.
 *
 * @private
 */
async function _authenticator(
  service: OagMcpService,
  opts: ServeOptions,
  resourceUrl: URL,
): Promise<HttpAuthenticator> {
  const { config, logs } = opts;
  try {
    return await createHttpAuthenticator({
      config,
      resolver: new SecretResolver({
        secretsFile: config.upstreamAuth.secretsFile,
        baseDir: opts.configBaseDir,
      }),
      registry: secrets,
      logs,
      resourceUrl,
      resourceName: `${service.info.api.title} (oag-mcp)`,
    });
  } catch (err) {
    logs.audit(
      "security.config_invalid",
      "failure",
      {
        area: "mcpAuth",
        errorCode: err instanceof OagMcpError ? err.code : "UNEXPECTED",
      },
      "error",
    );
    throw err;
  }
}

/**
 * The Streamable HTTP MCP request handler: creates an MCP server for each
 * authenticated request's principal, and refuses a request that arrives
 * without one (routing authenticates first; this is a second line).
 *
 * @param {Object} service - the service the tools call
 * @param {Object} logs - logs
 * @return {Object} MCP handler
 */
export function mcpRequestHandler(
  service: OagMcpService,
  logs: Logs,
): ReturnType<typeof createMcpHandler> {
  return createMcpHandler(
    ({ authInfo }) => {
      const extra = (authInfo?.extra ?? {}) as {
        principal?: Principal;
        requestId?: string;
        client?: ClientEndpoint;
      };
      if (!extra.principal) {
        throw new Error("unauthenticated request reached the MCP handler");
      }
      return createMcpServer(
        service,
        extra.principal,
        "streamable-http",
        extra.requestId,
        extra.client,
      );
    },
    {
      onerror: (err) =>
        logs.op("warn", "transport.request_failed", {
          transport: "streamable-http",
          error: err.name,
        }),
    },
  );
}

/**
 * Host header validation: the localhost names plus the configured hosts on
 * loopback binds; elsewhere the configured hosts, if any.
 *
 * @private
 */
function _hostValidator(
  h: Config["http"],
  loopback: boolean,
): RequestValidator | undefined {
  if (loopback) {
    return hostHeaderValidation([
      ...localhostAllowedHostnames(),
      ...h.allowedHosts,
    ]);
  }
  return h.allowedHosts.length > 0
    ? hostHeaderValidation(h.allowedHosts)
    : undefined;
}

/**
 * Origin validation: exactly the configured origins, otherwise loopback
 * origins on loopback binds and none elsewhere. Requests without an Origin
 * header (non-browser clients) pass.
 *
 * @private
 */
function _originValidator(
  h: Config["http"],
  loopback: boolean,
): RequestValidator {
  if (h.allowedOrigins.length > 0) {
    return _exactOriginValidation(h.allowedOrigins);
  }
  return loopback ? localhostOriginValidation() : originValidation([]);
}

/**
 * Admit only these origins, compared by scheme, host and port. The MCP SDK's
 * own guard compares hostnames only.
 *
 * @private
 */
function _exactOriginValidation(origins: string[]): RequestValidator {
  const allowed = new Set(origins.map(browserOrigin));
  return (req, res) => {
    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }
    const normalised = browserOrigin(origin);
    if (normalised !== undefined && allowed.has(normalised)) {
      return true;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Origin not allowed" },
        id: null,
      }),
    );
    return false;
  };
}

/**
 * Serve over Streamable HTTP.
 *
 * @private
 */
async function _serveHttp(
  service: OagMcpService,
  opts: ServeOptions,
): Promise<RunningServer> {
  const { logs, config } = opts;
  const h = config.http;
  const loopback = isLoopbackHost(h.host);
  _checkExposure(config, logs, loopback);
  const server = await _listen(h);
  const localUrl = _localUrl(server, h);
  const resourceUrl = new URL(h.publicUrl ?? localUrl);
  let authenticator: HttpAuthenticator;
  try {
    authenticator = await _authenticator(service, opts, resourceUrl);
  } catch (err) {
    server.close();
    throw err;
  }
  const handler = mcpRequestHandler(service, logs);
  const ctx: HttpContext = {
    h,
    logs,
    authenticator,
    nodeHandler: toNodeHandler(handler, {
      maxRequestBodySize: h.maxBodyBytes,
      onerror: (err) =>
        logs.op("error", "transport.error", {
          transport: "streamable-http",
          error: err.name,
        }),
    }),
    validateHost: _hostValidator(h, loopback),
    validateOrigin: _originValidator(h, loopback),
    resourceUrl,
  };
  server.on("request", (req, res) => _handleRequest(ctx, req, res));
  server.on("clientError", (err, socket) => {
    logs.op("warn", "transport.connection_failed", {
      transport: "streamable-http",
      error: err.name,
    });
    socket.destroy();
  });
  logs.op("info", "transport.initialized", {
    transport: "streamable-http",
    host: h.host,
    port: (server.address() as AddressInfo).port,
    path: h.path,
    mcpAuthMode: authenticator.mode,
    outcome: "success",
  });
  return {
    transport: "streamable-http",
    url: localUrl,
    close: async () => {
      await handler.close();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

/**
 * Handle one HTTP request, answering a server error when routing fails.
 *
 * @private
 */
async function _handleRequest(
  ctx: HttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const requestId = `req_${crypto.randomUUID()}`;
  const client = {
    clientAddress: req.socket.remoteAddress,
    clientPort: req.socket.remotePort,
  };
  const reqLogs = ctx.logs.child({
    requestId,
    transport: "streamable-http",
    ...client,
  });
  try {
    await _route(ctx, req, res, { requestId, client, reqLogs });
  } catch (err) {
    reqLogs.op("error", "transport.request_failed", {
      error: (err as Error).name,
    });
    if (!res.headersSent) {
      _respond(res, 500, '{"error":"server_error"}');
    }
  }
}

/**
 * Route one HTTP request: transport checks, health, discovery metadata,
 * authentication, then the MCP handler.
 *
 * @private
 */
async function _route(
  ctx: HttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  scope: HttpRequestScope,
): Promise<void> {
  if (!_admitted(ctx, req, res, scope.reqLogs)) {
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.searchParams.has("access_token") || url.searchParams.has("token")) {
    scope.reqLogs.audit(
      "authentication.token_in_url_rejected",
      "denied",
      {},
      "warn",
    );
    _respond(
      res,
      400,
      JSON.stringify({
        error: "invalid_request",
        error_description:
          "Access tokens must be sent in the Authorization header",
      }),
    );
    return;
  }
  if (url.pathname === "/healthz") {
    _respond(res, 200, '{"status":"ok"}');
    return;
  }
  const webReq = new Request(
    new URL(url.pathname + url.search, ctx.resourceUrl.origin),
    { method: req.method, headers: _headerPairs(req.headers) },
  );
  const meta = ctx.authenticator.metadata(webReq);
  if (meta) {
    await _relay(res, meta);
    return;
  }
  if (url.pathname !== ctx.h.path) {
    _respond(res, 404, '{"error":"not_found"}');
    return;
  }
  await _authenticateAndHandle(ctx, req, res, scope, webReq);
}

/**
 * Apply the Host and Origin checks, auditing a refusal.
 *
 * @private
 */
function _admitted(
  ctx: HttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqLogs: Logs,
): boolean {
  if (ctx.validateHost && !ctx.validateHost(req, res)) {
    reqLogs.audit(
      "transport.host_rejected",
      "denied",
      { httpMethod: req.method, reason: "host_not_allowed" },
      "warn",
    );
    return false;
  }
  if (!ctx.validateOrigin(req, res)) {
    reqLogs.audit(
      "transport.origin_rejected",
      "denied",
      { httpMethod: req.method, reason: "origin_not_allowed" },
      "warn",
    );
    return false;
  }
  return true;
}

/**
 * Authenticate a request to the MCP endpoint and hand it to the MCP
 * handler with its principal.
 *
 * @private
 */
async function _authenticateAndHandle(
  ctx: HttpContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  scope: HttpRequestScope,
  webReq: Request,
): Promise<void> {
  const auth = await ctx.authenticator.authenticate(
    webReq,
    scope.reqLogs.child({}),
  );
  if (!auth.ok) {
    await _relay(res, auth.response);
    return;
  }
  (req as http.IncomingMessage & { auth?: unknown }).auth = {
    ...auth.authInfo,
    extra: {
      ...(auth.authInfo.extra ?? {}),
      principal: auth.principal,
      requestId: scope.requestId,
      client: scope.client,
    },
  };
  await ctx.nodeHandler(req as never, res as never);
}

/**
 * Request headers as name/value pairs, one per value.
 *
 * @private
 */
function _headerPairs(
  headers: http.IncomingHttpHeaders,
): Array<[string, string]> {
  return Object.entries(headers).flatMap(([k, v]) =>
    (Array.isArray(v) ? v : [v])
      .filter((x): x is string => x !== undefined)
      .map((x): [string, string] => [k, x]),
  );
}

/**
 * Answer with a JSON body.
 *
 * @private
 */
function _respond(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/**
 * Answer with a web Response.
 *
 * @private
 */
async function _relay(res: http.ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
