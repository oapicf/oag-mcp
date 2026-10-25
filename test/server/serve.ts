"use strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import referee from "@sinonjs/referee";
import sinon from "sinon";

import { type Config, parseConfig } from "../../lib/config.js";
import type { PreparedSdk } from "../../lib/prepare/prepare.js";
import {
  type RunningServer,
  type ServeOptions,
  mcpRequestHandler,
  serve,
  servePrepared,
} from "../../lib/server/serve.js";
import { OagMcpService } from "../../lib/server/service.js";
import { quietLogs } from "../helpers/fakes.js";
import { tmpDir } from "../helpers/paths.js";
import { executor, prepared } from "../helpers/prepared.js";

const { assert, refute, match } = referee;

const ALICE = "alice-token-0123456789";

interface Started {
  running: RunningServer;
  sdk: PreparedSdk & { cleanup: sinon.SinonSpy };
  records: ReturnType<typeof quietLogs>["records"];
}

function config(raw: Record<string, unknown> = {}): Config {
  return parseConfig({
    upstream: { baseUrl: "https://api.example.test/v1" },
    execution: { typecheck: false },
    ...raw,
    http: { port: 0, ...(raw.http as Record<string, unknown>) },
  });
}

function options(
  cfg: Config,
  logs: ServeOptions["logs"],
  extra: Partial<ServeOptions> = {},
): ServeOptions {
  return {
    transport: "streamable-http",
    spec: "unused",
    sdk: "unused",
    config: cfg,
    configBaseDir: process.cwd(),
    logs,
    executor: executor(),
    ...extra,
  };
}

function fakeSdk(): Started["sdk"] {
  const sdk = prepared();
  return { ...sdk, cleanup: sinon.spy(() => true) };
}

async function start(
  raw: Record<string, unknown> = {},
  extra: Partial<ServeOptions> = {},
): Promise<Started> {
  const { logs, records } = quietLogs();
  const sdk = fakeSdk();
  const running = await servePrepared(sdk, options(config(raw), logs, extra));
  return { running, sdk, records };
}

/** A raw HTTP request, so the Host header and request target are ours. */
function rawRequest(
  url: string,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port,
        method: opts.method ?? "GET",
        path: opts.path ?? u.pathname + u.search,
        headers: opts.headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "unit", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: token
        ? { headers: { authorization: `Bearer ${token}` } }
        : undefined,
    }),
  );
  return client;
}

function events(records: Started["records"]): string[] {
  return records().map((r) => r.event);
}

describe("serve - servePrepared over Streamable HTTP", function () {
  this.timeout(20000);
  let started: Started | undefined;

  afterEach(async function () {
    sinon.restore();
    await started?.running.close();
    started = undefined;
  });

  it("should serve the tools to an MCP client and answer health checks", async function () {
    started = await start();
    const { running, sdk, records } = started;
    assert.equals(running.transport, "streamable-http");
    assert.match(running.url!, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await connect(running.url!);
    const tools = await client.listTools();
    assert.equals(tools.tools.map((t) => t.name).sort(), ["execute", "search"]);
    await client.close();
    const health = await fetch(new URL("/healthz", running.url));
    assert.equals(await health.json(), { status: "ok" });
    const ready = records().find((r) => r.event === "server.ready")!;
    assert.equals(ready.get("methods"), 2);
    assert.equals(
      records()
        .find((r) => r.event === "transport.initialized")!
        .get("mcpAuthMode"),
      "none",
    );
    const closing = running.close();
    assert.same(running.close(), closing);
    await closing;
    started = undefined;
    assert.equals(sdk.cleanup.callCount, 1);
    assert.contains(events(records), "prepare.workspace.cleaned");
    assert.contains(events(records), "server.stopped");
  });

  it("should refuse tokens in the URL and answer unknown paths with 404", async function () {
    started = await start();
    const { running, records } = started;
    const inUrl = await fetch(`${running.url}?access_token=abc`);
    assert.equals(inUrl.status, 400);
    assert.equals(
      ((await inUrl.json()) as { error: string }).error,
      "invalid_request",
    );
    assert.equals(
      (await fetch(new URL("/mcp?token=abc", running.url))).status,
      400,
    );
    assert.contains(events(records), "authentication.token_in_url_rejected");
    const missing = await fetch(new URL("/elsewhere", running.url));
    assert.equals(missing.status, 404);
    assert.equals(await missing.json(), { error: "not_found" });
  });

  it("should refuse requests for other hosts and from other origins on loopback", async function () {
    started = await start();
    const { running, records } = started;
    const host = await rawRequest(running.url!, {
      headers: { host: "evil.example.test" },
    });
    assert.equals(host.status, 403);
    const origin = await rawRequest(running.url!, {
      headers: { origin: "https://evil.example.test" },
    });
    assert.equals(origin.status, 403);
    const denied = records().filter((r) =>
      ["transport.host_rejected", "transport.origin_rejected"].includes(
        r.event,
      ),
    );
    assert.equals(
      denied.map((r) => [r.event, r.get("httpMethod"), r.get("reason")]),
      [
        ["transport.host_rejected", "GET", "host_not_allowed"],
        ["transport.origin_rejected", "GET", "origin_not_allowed"],
      ],
    );
  });

  it("should admit requests without an Origin when origins are configured", async function () {
    started = await start({
      http: { allowedOrigins: ["https://app.example.test"] },
    });
    const health = new URL("/healthz", started.running.url).toString();
    assert.equals((await rawRequest(health)).status, 200);
    assert.equals(
      (await rawRequest(health, { headers: { origin: "https://evil.test" } }))
        .status,
      403,
    );
  });

  it("should relay authentication challenges and serve authenticated callers", async function () {
    process.env.OAG_MCP_UNIT_ALICE = ALICE;
    try {
      started = await start({
        mcpAuth: {
          mode: "static-bearer",
          staticBearer: {
            tokens: [
              { principal: "alice", token: { env: "OAG_MCP_UNIT_ALICE" } },
            ],
          },
        },
      });
    } finally {
      delete process.env.OAG_MCP_UNIT_ALICE;
    }
    const { running, records } = started;
    const challenged = await fetch(running.url!, { method: "POST" });
    assert.equals(challenged.status, 401);
    assert.match(
      challenged.headers.get("www-authenticate")!,
      /^Bearer realm="oag-mcp"/,
    );
    const client = await connect(running.url!, ALICE);
    assert.equals((await client.listTools()).tools.length, 2);
    await client.close();
    const ok = records().find((r) => r.event === "authentication.succeeded")!;
    assert.equals(ok.principalId, "static:alice");
    assert.match(String(ok.requestId), /^req_/);
  });

  it("should serve protected resource metadata for the public URL", async function () {
    started = await start({
      http: { publicUrl: "https://mcp.example.test/mcp" },
      mcpAuth: {
        mode: "oauth",
        oauth: {
          issuer: "https://auth.example.test",
          jwksUri: "https://auth.example.test/jwks",
        },
      },
    });
    const res = await fetch(
      new URL("/.well-known/oauth-protected-resource", started.running.url),
    );
    assert.equals(res.status, 200);
    assert.equals(
      ((await res.json()) as { resource: string }).resource,
      "https://mcp.example.test/mcp",
    );
  });

  it("should answer a server error when a request cannot be routed", async function () {
    started = await start();
    const { running, records } = started;
    const res = await rawRequest(running.url!, { path: "http://[bad" });
    assert.equals(res.status, 500);
    assert.equals(JSON.parse(res.body), { error: "server_error" });
    const failed = records().find(
      (r) => r.event === "transport.request_failed",
    )!;
    assert.equals(failed.get("error"), "TypeError");
  });

  it("should drop connections that do not speak HTTP", async function () {
    started = await start();
    const { running, records } = started;
    const u = new URL(running.url!);
    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(u.port), u.hostname, () =>
        socket.write("NOT HTTP\r\n\r\n"),
      );
      socket.on("close", () => resolve());
      socket.on("error", () => resolve());
      socket.resume();
    });
    assert.contains(events(records), "transport.connection_failed");
  });

  it("should log requests the MCP handler rejects", async function () {
    started = await start();
    const { running, records } = started;
    const res = await rawRequest(running.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2099-01-01",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equals(res.status, 400);
    assert.contains(events(records), "transport.request_failed");
  });

  it("should refuse an oversized request body", async function () {
    started = await start();
    const res = await rawRequest(started.running.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "x".repeat(2 * 1024 * 1024),
    });
    assert.equals(res.status, 413);
  });
});

describe("serve - servePrepared on non-loopback addresses", function () {
  this.timeout(20000);
  // 127.0.0.1 in decimal: reachable only locally, but not one of the names
  // oag-mcp treats as loopback.
  const HOST = "2130706433";
  let started: Started | undefined;

  afterEach(async function () {
    sinon.restore();
    await started?.running.close();
    started = undefined;
  });

  function bearer(http: Record<string, unknown> = {}) {
    process.env.OAG_MCP_UNIT_ALICE = ALICE;
    return start({
      http: { host: HOST, ...http },
      mcpAuth: {
        mode: "static-bearer",
        staticBearer: {
          tokens: [
            { principal: "alice", token: { env: "OAG_MCP_UNIT_ALICE" } },
          ],
        },
      },
    }).finally(() => delete process.env.OAG_MCP_UNIT_ALICE);
  }

  it("should refuse to serve unauthenticated callers, and clean up", async function () {
    const { logs, records } = quietLogs();
    const sdk = fakeSdk();
    await assert.rejects(
      servePrepared(sdk, options(config({ http: { host: HOST } }), logs)),
      match({ code: "MCP_AUTH_REQUIRED" }),
    );
    assert.equals(sdk.cleanup.callCount, 1);
    assert.contains(
      events(records),
      "security.unauthenticated_nonloopback_refused",
    );
  });

  it("should warn about remote exposure and refuse every cross-origin request", async function () {
    started = await bearer();
    const { running, records } = started;
    assert.match(running.url!, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.contains(events(records), "transport.remote_exposure");
    const health = new URL("/healthz", running.url).toString();
    const anyHost = await rawRequest(health, {
      headers: { host: "anything.example.test" },
    });
    assert.equals(anyHost.status, 200);
    const origin = await rawRequest(health, {
      headers: { origin: "https://app.example.test" },
    });
    assert.equals(origin.status, 403);
  });

  it("should log a request the MCP transport cannot convert", async function () {
    started = await bearer();
    const { running, records } = started;
    const res = await rawRequest(running.url!, {
      method: "POST",
      headers: {
        host: "bad host",
        authorization: `Bearer ${ALICE}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{}",
    });
    assert.equals(res.status, 500);
    assert.contains(events(records), "transport.error");
  });

  it("should check the Host header against configured hosts", async function () {
    started = await bearer({ allowedHosts: ["mcp.example.test"] });
    const health = new URL("/healthz", started.running.url).toString();
    assert.equals(
      (await rawRequest(health, { headers: { host: "mcp.example.test" } }))
        .status,
      200,
    );
    assert.equals(
      (await rawRequest(health, { headers: { host: "evil.example.test" } }))
        .status,
      403,
    );
  });
});

describe("serve - servePrepared start-up failures", function () {
  this.timeout(20000);

  afterEach(function () {
    sinon.restore();
  });

  it("should audit an invalid authentication configuration and clean up", async function () {
    const { logs, records } = quietLogs();
    const sdk = fakeSdk();
    await assert.rejects(
      servePrepared(
        sdk,
        options(config({ mcpAuth: { mode: "static-bearer" } }), logs),
      ),
      match({ code: "MCP_AUTH_CONFIG_INVALID" }),
    );
    assert.equals(sdk.cleanup.callCount, 1);
    assert.equals(
      records()
        .find((r) => r.event === "security.config_invalid")!
        .get("errorCode"),
      "MCP_AUTH_CONFIG_INVALID",
    );
  });

  it("should fail when the port is taken, and clean up", async function () {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    try {
      const { port } = blocker.address() as net.AddressInfo;
      const { logs } = quietLogs();
      const sdk = fakeSdk();
      await assert.rejects(
        servePrepared(sdk, options(config({ http: { port } }), logs)),
        match({ code: "EADDRINUSE" }),
      );
      assert.equals(sdk.cleanup.callCount, 1);
    } finally {
      blocker.close();
    }
  });

  it("should not start a transport once start-up is cancelled", async function () {
    const { logs, records } = quietLogs();
    const sdk = fakeSdk();
    const abort = new AbortController();
    // The shutdown signal arrives as the executor stage completes.
    const op = logs.op.bind(logs);
    sinon.stub(logs, "op").callsFake((level, event, fields) => {
      op(level, event, fields);
      if (event === "prepare.stage.completed") {
        abort.abort();
      }
    });
    await assert.rejects(
      servePrepared(sdk, options(config(), logs, { signal: abort.signal })),
      match({ code: "STARTUP_ABORTED" }),
    );
    assert.equals(sdk.cleanup.callCount, 1);
    refute.contains(events(records), "transport.initialized");
  });
});

describe("serve - servePrepared over stdio", function () {
  this.timeout(20000);

  it("should speak MCP on the given streams as the configured local principal", async function () {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const replies: Array<Record<string, unknown>> = [];
    let buffer = "";
    stdout.on("data", (c: Buffer) => {
      buffer += c.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    const next = async (count: number) => {
      while (replies.length < count) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return replies[count - 1];
    };
    const { logs, records } = quietLogs();
    const sdk = fakeSdk();
    const running = await servePrepared(
      sdk,
      options(config({ mcpAuth: { stdio: { principal: "dev" } } }), logs, {
        transport: "stdio",
        stdio: { stdin, stdout },
      }),
    );
    try {
      assert.equals(running.transport, "stdio");
      assert.isUndefined(running.url);
      const send = (m: unknown) => stdin.write(`${JSON.stringify(m)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "unit", version: "1" },
        },
      });
      assert.equals((await next(1)).id, 1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const list = (await next(2)) as { result: { tools: unknown[] } };
      assert.equals(list.result.tools.length, 2);
      stdin.emit("error", new Error("stdin failed"));
    } finally {
      await running.close();
    }
    const ok = records().find((r) => r.event === "authentication.succeeded")!;
    assert.equals(ok.principalId, "local:dev");
    assert.contains(events(records), "transport.error");
    assert.equals(sdk.cleanup.callCount, 1);
  });
});

describe("serve - serve", function () {
  it("should not serve when preparation fails", async function () {
    const { logs } = quietLogs();
    await assert.rejects(
      serve({
        ...options(config(), logs),
        spec: path.join(tmpDir(), "missing.yaml"),
        sdk: tmpDir(),
      }),
    );
  });
});

describe("serve - mcpRequestHandler", function () {
  it("should refuse a request that arrives without an authenticated principal", async function () {
    const { logs, records } = quietLogs();
    const svc = await OagMcpService.create({
      prepared: prepared(),
      config: config(),
      configBaseDir: process.cwd(),
      logs,
      executor: executor(),
    });
    const handler = mcpRequestHandler(svc, logs);
    try {
      const res = await handler.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "unit", version: "1" },
            },
          }),
        }),
      );
      assert.equals(res.status, 500);
    } finally {
      await handler.close();
    }
    const failed = records().find(
      (r) => r.event === "transport.request_failed",
    )!;
    assert.equals(failed.get("error"), "Error");
  });
});
