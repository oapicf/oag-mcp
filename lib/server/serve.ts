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

import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createHttpAuthenticator, isLoopbackHost } from "./authentication.js";
import type { Config } from "../config.js";
import { SecretResolver } from "../util/secrets.js";
import { OagMcpError } from "../errors.js";
import type { Logs } from "../logger.js";
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
}

/**
 * Prepare the SDK and start serving it.
 *
 * @param {Object} opts - serve options
 * @return {Promise} running server
 */
export async function serve(opts: ServeOptions): Promise<RunningServer> {
  const { config, logs } = opts;
  const started = Date.now();
  const prepared: PreparedSdk = await prepareSdk({ ...opts, logs });
  let running: RunningServer;
  let service: OagMcpService;
  try {
    service = await runStage(
      logs,
      "executor",
      () =>
        OagMcpService.create({
          prepared,
          config,
          configBaseDir: opts.configBaseDir,
          logs,
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
        ? await _serveStdio(service, opts)
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
async function _serveStdio(
  service: OagMcpService,
  opts: ServeOptions,
): Promise<RunningServer> {
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
  if (config.mcpAuth.mode === "none" && !loopback) {
    logs.audit(
      "security.unauthenticated_nonloopback_refused",
      "denied",
      { host: h.host, mode: "none" },
      "error",
    );
    throw new OagMcpError(
      "MCP_AUTH_REQUIRED",
      `Refusing to serve unauthenticated MCP on non-loopback address ${h.host}`,
      {
        hint: "Bind to 127.0.0.1, or configure mcpAuth.mode static-bearer or oauth. Terminate TLS in front of the server for remote access.",
      },
    );
  }
  if (!loopback) {
    logs.op("warn", "transport.remote_exposure", {
      host: h.host,
      note: "terminate HTTPS in a reverse proxy; oag-mcp serves plain HTTP",
    });
  }
  const resolver = new SecretResolver({
    secretsFile: config.upstreamAuth.secretsFile,
    baseDir: opts.configBaseDir,
  });

  let server: http.Server | undefined;
  const listen = await new Promise<AddressInfo>((resolve, reject) => {
    server = http.createServer();
    server.once("error", reject);
    server.listen(h.port, h.host, () =>
      resolve(server!.address() as AddressInfo),
    );
  });
  const hostForUrl =
    listen.family === "IPv6" ? `[${listen.address}]` : listen.address;
  const localUrl = `http://${hostForUrl}:${listen.port}${h.path}`;
  const resourceUrl = new URL(h.publicUrl ?? localUrl);
  let authenticator;
  try {
    authenticator = await createHttpAuthenticator({
      config,
      resolver,
      registry: secrets,
      logs,
      resourceUrl,
      resourceName: `${service.info.api.title} (oag-mcp)`,
    });
  } catch (err) {
    server!.close();
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

  const handler = createMcpHandler(
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
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: h.maxBodyBytes,
    onerror: (err) =>
      logs.op("error", "transport.error", {
        transport: "streamable-http",
        error: err.name,
      }),
  });
  const validateHost = loopback
    ? localhostHostValidation()
    : h.allowedHosts.length > 0
      ? hostHeaderValidation(h.allowedHosts)
      : undefined;
  const validateOrigin =
    h.allowedOrigins.length > 0
      ? originValidation(h.allowedOrigins)
      : loopback
        ? localhostOriginValidation()
        : originValidation([]);

  server!.on("request", async (req, res) => {
    const requestId = `req_${crypto.randomUUID()}`;
    const client = {
      clientAddress: req.socket.remoteAddress,
      clientPort: req.socket.remotePort,
    };
    const reqLogs = logs.child({
      requestId,
      transport: "streamable-http",
      ...client,
    });
    try {
      if (validateHost && !validateHost(req, res)) {
        reqLogs.audit(
          "transport.host_rejected",
          "denied",
          { httpMethod: req.method, reason: "host_not_allowed" },
          "warn",
        );
        return;
      }
      if (!validateOrigin(req, res)) {
        reqLogs.audit(
          "transport.origin_rejected",
          "denied",
          { httpMethod: req.method, reason: "origin_not_allowed" },
          "warn",
        );
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        url.searchParams.has("access_token") ||
        url.searchParams.has("token")
      ) {
        reqLogs.audit(
          "authentication.token_in_url_rejected",
          "denied",
          {},
          "warn",
        );
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "invalid_request",
            error_description:
              "Access tokens must be sent in the Authorization header",
          }),
        );
        return;
      }
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      const webReq = new Request(
        new URL(url.pathname + url.search, resourceUrl.origin),
        {
          method: req.method,
          headers: Object.entries(req.headers).flatMap(([k, v]) =>
            v === undefined
              ? []
              : Array.isArray(v)
                ? v.map((x) => [k, x] as [string, string])
                : [[k, v] as [string, string]],
          ),
        },
      );
      const meta = authenticator.metadata(webReq);
      if (meta) {
        res.writeHead(meta.status, Object.fromEntries(meta.headers));
        res.end(Buffer.from(await meta.arrayBuffer()));
        return;
      }
      if (url.pathname !== h.path) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not_found"}');
        return;
      }
      const auth = await authenticator.authenticate(webReq, reqLogs.child({}));
      if (!auth.ok) {
        res.writeHead(
          auth.response.status,
          Object.fromEntries(auth.response.headers),
        );
        res.end(Buffer.from(await auth.response.arrayBuffer()));
        return;
      }
      (req as http.IncomingMessage & { auth?: unknown }).auth = {
        ...auth.authInfo,
        extra: {
          ...(auth.authInfo.extra ?? {}),
          principal: auth.principal,
          requestId,
          client,
        },
      };
      await nodeHandler(req as never, res as never);
    } catch (err) {
      reqLogs.op("error", "transport.request_failed", {
        error: (err as Error).name,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"server_error"}');
      }
    }
  });
  server!.on("clientError", (err, socket) => {
    logs.op("warn", "transport.connection_failed", {
      transport: "streamable-http",
      error: (err as Error).name,
    });
    socket.destroy();
  });
  logs.op("info", "transport.initialized", {
    transport: "streamable-http",
    host: h.host,
    port: listen.port,
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
        server!.close(() => resolve()),
      );
      server!.closeAllConnections?.();
      await closed;
    },
  };
}
