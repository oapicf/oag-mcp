"use strict";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import referee from "@sinonjs/referee";

import { parseConfig } from "../../lib/config.js";
import { OagMcpService } from "../../lib/server/service.js";
import {
  TOOL_NAMES,
  createMcpServer,
  executeDescription,
  searchDescription,
} from "../../lib/server/tools.js";
import type { Principal } from "../../lib/types.js";
import { quietLogs } from "../helpers/fakes.js";
import { executor, prepared } from "../helpers/prepared.js";

const { assert, refute } = referee;

const principal: Principal = {
  id: "local:dev",
  kind: "local",
  name: "dev",
  scopes: [],
};

async function service(run?: Parameters<typeof executor>[0]) {
  const { logs, records } = quietLogs();
  const svc = await OagMcpService.create({
    prepared: prepared(),
    config: parseConfig({
      upstream: { baseUrl: "https://api.example.test/v1" },
      execution: { typecheck: false },
    }),
    configBaseDir: process.cwd(),
    logs,
    executor: executor(run),
  });
  return { svc, records };
}

async function connect(
  svc: OagMcpService,
  ...args: [string?, Record<string, unknown>?]
) {
  const server = createMcpServer(
    svc,
    principal,
    "streamable-http",
    ...(args as [string?, never?]),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "unit", version: "1" });
  await client.connect(clientSide);
  return { client, server };
}

describe("tools - descriptions", function () {
  it("should name the API and its classes", async function () {
    const { svc } = await service();
    assert.match(
      searchDescription(svc),
      /^Discover methods of the Pet Clinic SDK/,
    );
    assert.match(
      executeDescription(svc),
      /exposes the SDK API classes: AdminApi, PetsApi\./,
    );
  });
});

describe("tools - createMcpServer", function () {
  it("should expose exactly search and execute with their hints", async function () {
    const { svc } = await service();
    const { client, server } = await connect(svc);
    try {
      const { tools } = await client.listTools();
      assert.equals(
        tools.map((t) => t.name),
        [...TOOL_NAMES],
      );
      const [search, execute] = tools;
      assert.equals(search.description, searchDescription(svc));
      assert.isTrue(search.annotations!.readOnlyHint!);
      assert.isTrue(execute.annotations!.destructiveHint!);
      assert.equals(client.getServerVersion()!.title, "Pet Clinic (oag-mcp)");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should answer search calls with text and structured content", async function () {
    const { svc } = await service();
    const { client, server } = await connect(svc, "req_http_1", {
      clientAddress: "127.0.0.1",
      clientPort: 5000,
    });
    try {
      const browse = await client.callTool({ name: "search", arguments: {} });
      refute(browse.isError);
      assert.equals(
        JSON.parse((browse.content as Array<{ text: string }>)[0].text),
        browse.structuredContent,
      );
      const missing = await client.callTool({
        name: "search",
        arguments: { id: "NopeApi.nothing" },
      });
      assert.isTrue(missing.isError);
      assert.match(
        String((missing.structuredContent as { error: string }).error),
        /No method with id "NopeApi.nothing"/,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should report failed executions as tool errors", async function () {
    let n = 0;
    const { svc, records } = await service(async () =>
      ++n === 1
        ? { ok: true, result: { pets: 2 } }
        : {
            ok: false,
            error: { type: "runtime_error", message: "boom" },
          },
    );
    const { client, server } = await connect(svc, "req_http_2");
    try {
      const ok = await client.callTool({
        name: "execute",
        arguments: { code: "return 1;", language: "javascript" },
      });
      refute(ok.isError);
      assert.equals((ok.structuredContent as { result: unknown }).result, {
        pets: 2,
      });
      const failed = await client.callTool({
        name: "execute",
        arguments: { code: "return 2;", language: "javascript" },
      });
      assert.isTrue(failed.isError);
    } finally {
      await client.close();
      await server.close();
    }
    const requested = records().filter(
      (r) => r.event === "execution.requested",
    );
    assert.equals(
      requested.map((r) => r.requestId),
      ["req_http_2", "req_http_2"],
    );
  });

  it("should give each call its own request id without an HTTP request", async function () {
    const { svc, records } = await service();
    const server = createMcpServer(svc, principal, "stdio");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "unit", version: "1" });
    await client.connect(clientSide);
    try {
      await client.callTool({ name: "search", arguments: { query: "pets" } });
      await client.callTool({ name: "search", arguments: { query: "pets" } });
    } finally {
      await client.close();
      await server.close();
    }
    const ids = records()
      .filter(
        (r) => r.event === "search.completed" || r.event === "tool.called",
      )
      .map((r) => r.requestId);
    assert.greater(new Set(ids).size, 1);
    for (const id of ids) {
      assert.match(String(id), /^req_[0-9a-f-]{36}$/);
    }
  });
});
