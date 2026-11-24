"use strict";
/**
 * Every combination of MCP Auth and Upstream Auth: for each MCP Auth mode
 * (stdio, none, static bearer, OAuth with JWTs and with introspection), one
 * server, through which one SDK call is made for each upstream scheme (none,
 * an API key in a header and in the query, HTTP basic and bearer, and OAuth2
 * client credentials). For every combination, the API must receive exactly
 * the scheme's credential and never the MCP token, and the audit record of
 * the call must name the expected principal and scheme.
 */
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import referee from "@sinonjs/referee";

import { opaquePrincipalId } from "../lib/server/authorization.js";
import {
  BIN,
  SECRET_ENV,
  SERVE_ARGS,
  startHttpServer,
  upstreamAuthConfig,
  workDir,
  writeConfig,
} from "./helpers/env.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  API_KEY,
  BEARER_TOKEN,
  type MockApi,
  type RecordedRequest,
  startMockApi,
} from "./helpers/mock-api.js";
import {
  type AuthServer,
  INTROSPECTION_CLIENT_ID,
  INTROSPECTION_CLIENT_SECRET,
  startAuthServer,
} from "./helpers/auth-server.js";
import {
  type LogRecordView,
  readLogRecords,
} from "../test/helpers/log-records.js";

const { assert, refute } = referee;

const STATIC_TOKEN = "matrix-static-token-0123456789";
const PRINCIPAL_ID_KEY = "matrix-principal-id-key-0123456789abcdef";
const SUBJECT = "alice@example.com";

let api: MockApi;
let auth: AuthServer;

before(async function () {
  this.timeout(120000);
  auth = await startAuthServer();
  api = await startMockApi({ oauthTokens: auth.upstreamTokens });
});

after(async function () {
  await api?.close();
  await auth?.close();
});

/** An upstream scheme, and the fixture operation that uses only it. */
interface Upstream {
  name: string;
  /** Scheme names recorded for the call. */
  schemes: string[];
  operation: string;
  /** Agent code making the call; `n` keeps pet ids apart between modes. */
  code: (n: number) => string;
  /** Check that the API received exactly the scheme's credential. */
  received: (r: RecordedRequest) => void;
}

const basic = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64")}`;

const UPSTREAMS: Upstream[] = [
  {
    name: "none",
    schemes: [],
    operation: "PetsApi.getPetById",
    code: () => "return await sdk.PetsApi.getPetById({ petId: 1 });",
    received: (r) => {
      assert.isUndefined(r.headers.authorization);
      assert.isUndefined(r.headers["x-api-key"]);
      assert.isUndefined(r.query.api_key);
    },
  },
  {
    name: "api-key-header",
    schemes: ["apiKeyHeader"],
    operation: "PetsApi.listPets",
    code: () => "return await sdk.PetsApi.listPets({ limit: 1 });",
    received: (r) => {
      assert.equals(r.headers["x-api-key"], API_KEY);
      assert.isUndefined(r.headers.authorization);
    },
  },
  {
    name: "api-key-query",
    schemes: ["apiKeyQuery"],
    operation: "OwnersApi.listOwners",
    code: () => "return await sdk.OwnersApi.listOwners({});",
    received: (r) => {
      assert.equals(r.query.api_key, API_KEY);
      assert.isUndefined(r.headers.authorization);
    },
  },
  {
    name: "basic",
    schemes: ["adminBasic"],
    operation: "AdminApi.deletePet",
    code: (n) =>
      `await sdk.AdminApi.deletePet({ petId: ${n + 2} }); return "ok";`,
    received: (r) => assert.equals(r.headers.authorization, basic),
  },
  {
    name: "bearer",
    schemes: ["bearerAuth"],
    operation: "StoreApi.getStoreInventory",
    code: () => "return await sdk.StoreApi.getStoreInventory();",
    received: (r) =>
      assert.equals(r.headers.authorization, `Bearer ${BEARER_TOKEN}`),
  },
  {
    name: "oauth2-client-credentials",
    schemes: ["clinicOAuth"],
    operation: "PetsApi.createPet",
    code: () =>
      'return await sdk.PetsApi.createPet({ newPet: { name: "Matrix", species: "cat", ownerId: 1 } });',
    received: (r) => {
      const token = String(r.headers.authorization).replace(/^Bearer /, "");
      assert.contains(auth.upstreamTokens.get(token) ?? [], "pets:write");
    },
  },
];

/** A running server for one MCP Auth mode, with a connected client. */
interface Session {
  client: Client;
  log: string;
  principal: string;
  /** The MCP credential, which must never reach the API. */
  mcpToken?: string;
  close: () => Promise<void>;
}

/** An MCP Auth mode and how to start a server and connect a client. */
interface Mode {
  name: string;
  start: () => Promise<Session>;
}

/** Start an HTTP server with `mcpAuth` and connect a client to it. */
async function httpSession(
  name: string,
  mcpAuth: (resource: string) => Record<string, unknown>,
  token: (resource: string) => Promise<string | undefined>,
  principal: string,
  env: Record<string, string> = {},
): Promise<Session> {
  const dir = workDir(`matrix-${name}`);
  const port = 41000 + Math.floor(Math.random() * 1000);
  const resource = `http://127.0.0.1:${port}/mcp`;
  const log = path.join(dir, "oag-mcp.log");
  const config = writeConfig(dir, {
    upstream: { baseUrl: api.baseUrl },
    upstreamAuth: upstreamAuthConfig(auth),
    mcpAuth: mcpAuth(resource),
    http: { port },
  });
  const server = await startHttpServer(
    [
      ...SERVE_ARGS,
      "--config",
      config,
      "--port",
      String(port),
      "--log-file",
      log,
      "--audit-log-file",
      log,
    ],
    env,
  );
  const mcpToken = await token(resource);
  const client = new Client({ name: "matrix", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: mcpToken
        ? { headers: { authorization: `Bearer ${mcpToken}` } }
        : {},
    }),
  );
  return {
    client,
    log,
    principal,
    mcpToken,
    close: async () => {
      await client.close();
      await server.stop();
    },
  };
}

const oauthPrincipal = () =>
  opaquePrincipalId("oauth", [auth.issuer, SUBJECT], PRINCIPAL_ID_KEY);

const MODES: Mode[] = [
  {
    name: "stdio",
    start: async () => {
      const dir = workDir("matrix-stdio");
      const log = path.join(dir, "oag-mcp.log");
      const config = writeConfig(dir, {
        upstream: { baseUrl: api.baseUrl },
        upstreamAuth: upstreamAuthConfig(auth),
        mcpAuth: { stdio: { principal: "matrix-agent" } },
      });
      const client = new Client({ name: "matrix", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            BIN,
            "serve",
            ...SERVE_ARGS,
            "--config",
            config,
            "--transport",
            "stdio",
            "--log-file",
            log,
            "--audit-log-file",
            log,
          ],
          env: { ...(process.env as Record<string, string>), ...SECRET_ENV },
          stderr: "ignore",
        }),
      );
      return {
        client,
        log,
        principal: "local:matrix-agent",
        close: () => client.close(),
      };
    },
  },
  {
    name: "none",
    start: () =>
      httpSession(
        "none",
        () => ({ mode: "none" }),
        async () => undefined,
        "anonymous",
      ),
  },
  {
    name: "static-bearer",
    start: () =>
      httpSession(
        "static",
        () => ({
          mode: "static-bearer",
          staticBearer: {
            tokens: [
              { principal: "matrix-agent", token: { env: "MCP_TOKEN" } },
            ],
          },
        }),
        async () => STATIC_TOKEN,
        "static:matrix-agent",
        { MCP_TOKEN: STATIC_TOKEN },
      ),
  },
  {
    name: "oauth (JWT)",
    start: () =>
      httpSession(
        "oauth-jwt",
        () => ({
          mode: "oauth",
          oauth: {
            issuer: auth.issuer,
            allowInsecureIssuer: true,
            principalIdKey: { env: "PRINCIPAL_ID_KEY" },
          },
        }),
        (resource) =>
          auth.mint({ sub: SUBJECT, client_id: "matrix-app", aud: resource }),
        oauthPrincipal(),
        { PRINCIPAL_ID_KEY },
      ),
  },
  {
    name: "oauth (introspection)",
    start: () =>
      httpSession(
        "oauth-introspection",
        () => ({
          mode: "oauth",
          oauth: {
            issuer: auth.issuer,
            allowInsecureIssuer: true,
            principalIdKey: { env: "PRINCIPAL_ID_KEY" },
            introspection: {
              endpoint: auth.introspectionUrl,
              clientId: { env: "RS_ID" },
              clientSecret: { env: "RS_SECRET" },
            },
          },
        }),
        async (resource) => {
          const token = "matrix-opaque-token-0123456789";
          auth.opaqueTokens.set(token, {
            sub: SUBJECT,
            client_id: "matrix-app",
            aud: resource,
            iss: auth.issuer,
            exp: Math.floor(Date.now() / 1000) + 600,
          });
          return token;
        },
        oauthPrincipal(),
        {
          PRINCIPAL_ID_KEY,
          RS_ID: INTROSPECTION_CLIENT_ID,
          RS_SECRET: INTROSPECTION_CLIENT_SECRET,
        },
      ),
  },
];

/** Wait for the audit record of an operation's call after `since` records. */
async function allowedRecord(
  log: string,
  operation: string,
  since: number,
): Promise<LogRecordView> {
  for (let i = 0; i < 50; i++) {
    const found = readLogRecords(log)
      .slice(since)
      .find(
        (r) =>
          r.event === "authorization.allowed" &&
          (r.raw.api as { operation?: string } | undefined)?.operation ===
            operation,
      );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no authorization.allowed record for ${operation}`);
}

MODES.forEach((mode, n) => {
  describe(`auth-combinations - MCP Auth ${mode.name}`, function () {
    let session: Session;

    before(async function () {
      this.timeout(120000);
      session = await mode.start();
    });

    after(async function () {
      await session?.close();
    });

    for (const upstream of UPSTREAMS) {
      it(`should call the API with Upstream Auth ${upstream.name}`, async function () {
        const since = readLogRecords(session.log).length;
        const before = api.requests.length;
        const res = await session.client.callTool({
          name: "execute",
          arguments: { code: upstream.code(n) },
        });
        assert.isFalse(Boolean(res.isError), JSON.stringify(res.content));

        const sent = api.requests.slice(before);
        assert.equals(sent.length, 1);
        upstream.received(sent[0]);
        if (session.mcpToken) {
          refute.contains(JSON.stringify(sent[0]), session.mcpToken);
        }

        const record = await allowedRecord(
          session.log,
          upstream.operation,
          since,
        );
        const raw = record.raw as {
          actor: { user: { uid: string } };
          unmapped: { schemes: string[]; unauthenticated: boolean };
        };
        assert.equals(raw.actor.user.uid, session.principal);
        assert.equals(raw.unmapped.schemes, upstream.schemes);
        assert.equals(
          raw.unmapped.unauthenticated,
          upstream.schemes.length === 0,
        );
      });
    }
  });
});
