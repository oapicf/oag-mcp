"use strict";
/**
 * Verification 7: both MCP transports support discovery and execution with
 * identical tool behaviour.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import referee from "@sinonjs/referee";

import {
  BIN,
  SECRET_ENV,
  SERVE_ARGS,
  startHttpServer,
  upstreamAuthConfig,
  workDir,
  writeConfig,
} from "./helpers/env.js";
import { type MockApi, startMockApi } from "./helpers/mock-api.js";

const { assert } = referee;

let api: MockApi;
let config: string;

before(async function () {
  this.timeout(120000);
  api = await startMockApi();
  config = writeConfig(workDir("transports"), {
    upstream: { baseUrl: api.baseUrl },
    upstreamAuth: upstreamAuthConfig(),
  });
});

after(async function () {
  await api?.close();
});

const CODE = `const dogs = await sdk.PetsApi.listPets({ species: "dog" });\nconst visits = await sdk.PetsApi.listPetVisits({ petId: dogs[0].id });\nreturn { dogs: dogs.map((d) => d.name), firstVisit: visits[0].reason };`;
const EXPECTED = { dogs: ["Biscuit", "Ziggy", "Maple"], firstVisit: "checkup" };

async function exercise(client: Client) {
  const tools = await client.listTools();
  const search = await client.callTool({
    name: "search",
    arguments: { query: "vet visits" },
  });
  const detail = await client.callTool({
    name: "search",
    arguments: { id: "PetsApi.listPetVisits" },
  });
  const exec = await client.callTool({
    name: "execute",
    arguments: { code: CODE },
  });
  const bad = await client.callTool({
    name: "execute",
    arguments: { code: "return sdk.PetsApi.nope();" },
  });
  return { tools, search, detail, exec, bad };
}

describe("transports - stdio and Streamable HTTP", function () {
  it("should expose the same two tools and behaviour on both transports", async function () {
    this.timeout(120000);
    const stdioClient = new Client({ name: "it-stdio", version: "1" });
    await stdioClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          BIN,
          "serve",
          ...SERVE_ARGS,
          "--transport",
          "stdio",
          "--config",
          config,
          "--log-level",
          "warn",
        ],
        env: { ...(process.env as Record<string, string>), ...SECRET_ENV },
        stderr: "ignore",
      }),
    );
    const viaStdio = await exercise(stdioClient);
    await stdioClient.close();

    const server = await startHttpServer(
      [...SERVE_ARGS, "--config", config, "--log-level", "warn"],
      SECRET_ENV,
    );
    try {
      const httpClient = new Client({ name: "it-http", version: "1" });
      await httpClient.connect(
        new StreamableHTTPClientTransport(new URL(server.url)),
      );
      const viaHttp = await exercise(httpClient);
      await httpClient.close();

      for (const r of [viaStdio, viaHttp]) {
        assert.equals(
          r.tools.tools.map((t) => t.name),
          ["search", "execute"],
        );
        assert.equals(
          (r.search.structuredContent as { results: Array<{ id: string }> })
            .results[0].id,
          "PetsApi.listPetVisits",
        );
        assert.match(
          (r.detail.structuredContent as { method: { signature: string } })
            .method.signature,
          /^listPetVisits/,
        );
        assert.equals(
          (r.exec.structuredContent as { result: unknown }).result,
          EXPECTED,
        );
        assert.isTrue(Boolean(r.bad.isError));
        assert.equals(
          (r.bad.structuredContent as { error: { type: string } }).error.type,
          "type_error",
        );
      }
      assert.equals(
        JSON.stringify(viaStdio.tools),
        JSON.stringify(viaHttp.tools),
      );
    } finally {
      await server.stop();
    }
  });

  it("should serve Streamable HTTP (not legacy HTTP+SSE) on loopback with DNS rebinding protection", async function () {
    this.timeout(60000);
    const server = await startHttpServer(
      [...SERVE_ARGS, "--config", config, "--log-level", "warn"],
      SECRET_ENV,
    );
    try {
      const u = new URL(server.url);
      assert.equals(u.hostname, "127.0.0.1");
      const legacy = await fetch(new URL("/sse", u));
      assert.equals(legacy.status, 404);
      const get = await fetch(u, { headers: { accept: "text/event-stream" } });
      assert.equals(get.status, 405);
      const health = await fetch(new URL("/healthz", u));
      assert.equals(health.status, 200);
      const rebinding = await new Promise<number>((resolve, reject) => {
        import("node:http").then((http) => {
          const req = http.request(
            {
              host: u.hostname,
              port: u.port,
              path: u.pathname,
              method: "POST",
              headers: {
                host: "evil.example.test",
                "content-type": "application/json",
              },
            },
            (res) => resolve(res.statusCode ?? 0),
          );
          req.on("error", reject);
          req.end("{}");
        });
      });
      assert.equals(rebinding, 403);
      const origin = await fetch(u, {
        method: "POST",
        headers: {
          origin: "https://evil.example.test",
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equals(origin.status, 403);
    } finally {
      await server.stop();
    }
  });
});
