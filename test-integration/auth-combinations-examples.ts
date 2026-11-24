"use strict";
/**
 * The examples in examples/auth-combinations/: they must match what
 * test-integration/helpers/auth-combinations.ts renders, and every folder
 * must work as its README says. For each folder, a copy is made with the
 * configuration pointed at a local Pet Store API and authorization server,
 * and the SDK generated from its openapi.yaml (test/fixtures/
 * auth-combinations/); its own serve.sh is run, an MCP client connects as the
 * README describes, and every API operation is called. The API must receive
 * the folder's upstream credentials and never the MCP token, and the audit
 * records must name the principal and scheme the README says.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import referee from "@sinonjs/referee";
import YAML from "yaml";

import { parseConfig } from "../lib/config.js";
import { loadSpec } from "../lib/prepare/spec.js";
import { opaquePrincipalId } from "../lib/server/authorization.js";
import {
  MCP_AUTHS,
  type McpAuth,
  OPENAPI_GENERATOR_VERSION,
  UPSTREAM_AUTHS,
  type UpstreamAuth,
  folderName,
  renderAll,
} from "./helpers/auth-combinations.js";
import { BIN, workDir } from "./helpers/env.js";
import {
  type AuthServer,
  UPSTREAM_CLIENT_ID,
  UPSTREAM_CLIENT_SECRET,
  startAuthServer,
} from "./helpers/auth-server.js";
import {
  PETSTORE_ENV,
  type PetstoreApi,
  startPetstoreApi,
} from "./helpers/petstore-api.js";
import { readLogRecords } from "../test/helpers/log-records.js";

const { assert, refute } = referee;

const ROOT = path.join(import.meta.dirname, "..");
const EXAMPLES = path.join(ROOT, "examples", "auth-combinations");
const SDKS = path.join(ROOT, "test", "fixtures", "auth-combinations");

const MCP_TOKEN = "examples-static-token-0123456789";
const PRINCIPAL_ID_KEY = "examples-principal-id-key-0123456789abcdef";
const SUBJECT = "alice@example.com";

let auth: AuthServer;
let shims: string;

before(async function () {
  this.timeout(60000);
  auth = await startAuthServer();
  // serve.sh runs `oag-mcp`: make it this checkout's CLI.
  shims = workDir("examples-bin");
  fs.writeFileSync(
    path.join(shims, "oag-mcp"),
    `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`,
    { mode: 0o755 },
  );
});

after(async function () {
  await auth?.close();
});

describe("auth-combinations-examples - files", function () {
  it("should match what the generator renders", function () {
    const expected = renderAll();
    for (const [file, content] of expected) {
      assert.equals(
        fs.readFileSync(path.join(EXAMPLES, file), "utf8"),
        content,
        `${file} is out of date: run make -f Makefile-extras gen-auth-combinations`,
      );
    }
    const folders = fs
      .readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    assert.equals(
      folders,
      MCP_AUTHS.flatMap((m) =>
        UPSTREAM_AUTHS.map((u) => folderName(m, u)),
      ).sort(),
    );
  });

  it("should generate SDKs with the OpenAPI Generator version of Makefile-extras", function () {
    const makefile = fs.readFileSync(
      path.join(ROOT, "Makefile-extras"),
      "utf8",
    );
    assert.match(
      makefile,
      new RegExp(
        `^OPENAPI_GENERATOR_VERSION = ${OPENAPI_GENERATOR_VERSION}$`,
        "m",
      ),
    );
    for (const upstream of UPSTREAM_AUTHS) {
      assert.equals(
        fs
          .readFileSync(
            path.join(
              SDKS,
              `sdk-${upstream.id}`,
              ".openapi-generator",
              "VERSION",
            ),
            "utf8",
          )
          .trim(),
        OPENAPI_GENERATOR_VERSION,
      );
    }
  });

  it("should have valid configurations for the schemes their documents declare", async function () {
    for (const mcp of MCP_AUTHS) {
      for (const upstream of UPSTREAM_AUTHS) {
        const dir = path.join(EXAMPLES, folderName(mcp, upstream));
        const config = parseConfig(
          YAML.parse(
            fs.readFileSync(path.join(dir, "oag-mcp.config.yaml"), "utf8"),
          ),
        );
        const spec = await loadSpec(path.join(dir, "openapi.yaml"));
        assert.equals(
          Object.keys(config.upstreamAuth.schemes),
          upstream.scheme ? [upstream.scheme] : [],
        );
        assert.equals(
          Object.keys(spec.securitySchemes),
          upstream.scheme ? [upstream.scheme] : [],
        );
        assert.equals(
          config.mcpAuth.mode,
          mcp.transport === "stdio" ? "none" : mcp.id,
        );
      }
    }
  });
});

/** Copy a folder to a work directory, set up as its README says. */
function prepareFolder(
  mcp: McpAuth,
  upstream: UpstreamAuth,
  api: PetstoreApi,
  port: number,
): string {
  const name = folderName(mcp, upstream);
  const dir = workDir(`example-${name}`);
  fs.cpSync(path.join(EXAMPLES, name), dir, { recursive: true });
  fs.cpSync(
    path.join(SDKS, `sdk-${upstream.id}`),
    path.join(dir, "generated-sdk"),
    {
      recursive: true,
    },
  );

  // Point the configuration at the local API and authorization server.
  const file = path.join(dir, "oag-mcp.config.yaml");
  const config = YAML.parse(fs.readFileSync(file, "utf8"));
  config.upstream.baseUrl = api.baseUrl;
  if (upstream.scheme === "petstoreOAuth") {
    config.upstreamAuth.allowInsecureTokenUrl = true;
    config.upstreamAuth.schemes.petstoreOAuth.tokenUrl = auth.tokenUrl;
  }
  if (mcp.id === "oauth") {
    config.mcpAuth.oauth.issuer = auth.issuer;
    config.mcpAuth.oauth.allowInsecureIssuer = true;
  }
  fs.writeFileSync(file, YAML.stringify(config));

  const serve = path.join(dir, "serve.sh");
  fs.writeFileSync(
    serve,
    fs.readFileSync(serve, "utf8").replace("--port 3000", `--port ${port}`),
  );
  return dir;
}

/** Start a folder's serve.sh over Streamable HTTP and wait until it listens. */
async function startServe(
  dir: string,
  env: Record<string, string>,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = spawn("bash", [path.join(dir, "serve.sh")], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve.sh did not start: ${stderr}`)),
      60000,
    );
    child.stderr!.on("data", () => {
      const m = /oag-mcp listening on (\S+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve.sh exited ${code}: ${stderr}`));
    });
  });
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.on("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** The MCP credential a folder's README has the client send. */
async function mcpToken(
  mcp: McpAuth,
  resource: string,
): Promise<string | undefined> {
  if (mcp.id === "static-bearer") return MCP_TOKEN;
  if (mcp.id === "oauth") {
    return auth.mint({
      sub: SUBJECT,
      client_id: "examples-app",
      aud: resource,
      scope: "mcp:tools",
    });
  }
  return undefined;
}

/** The principal a folder's README says the logs name. */
function principal(mcp: McpAuth): string {
  return mcp.id === "oauth"
    ? opaquePrincipalId("oauth", [auth.issuer, SUBJECT], PRINCIPAL_ID_KEY)
    : mcp.principal;
}

const CODE = [
  "const listed = await sdk.PetsApi.listPets({ limit: 1 });",
  "const pet = await sdk.PetsApi.getPetById({ petId: 1 });",
  'const created = await sdk.PetsApi.createPet({ newPet: { name: "Kyo", species: "cat" } });',
  "return { listed: listed.length, name: pet.name, created: created.id };",
].join("\n");

for (const mcp of MCP_AUTHS) {
  for (const upstream of UPSTREAM_AUTHS) {
    const name = folderName(mcp, upstream);

    describe(`auth-combinations-examples - ${name}`, function () {
      it("should call the API as the README says", async function () {
        this.timeout(120000);
        const api = await startPetstoreApi(upstream.id, auth.upstreamTokens);
        const port = 42000 + Math.floor(Math.random() * 1000);
        const dir = prepareFolder(mcp, upstream, api, port);
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          ...PETSTORE_ENV,
          PETSTORE_CLIENT_ID: UPSTREAM_CLIENT_ID,
          PETSTORE_CLIENT_SECRET: UPSTREAM_CLIENT_SECRET,
          OAG_MCP_TOKEN: MCP_TOKEN,
          OAG_MCP_PRINCIPAL_ID_KEY: PRINCIPAL_ID_KEY,
          PATH: `${shims}${path.delimiter}${process.env.PATH}`,
        };
        const client = new Client({ name: "examples", version: "1" });
        let token: string | undefined;
        let stop = () => client.close();
        try {
          if (mcp.transport === "stdio") {
            await client.connect(
              new StdioClientTransport({
                command: "bash",
                args: [path.join(dir, "serve.sh")],
                env,
                stderr: "ignore",
              }),
            );
          } else {
            const server = await startServe(dir, env);
            token = await mcpToken(mcp, server.url);
            stop = async () => {
              await client.close();
              await server.stop();
            };
            await client.connect(
              new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: token
                  ? { headers: { authorization: `Bearer ${token}` } }
                  : {},
              }),
            );
          }

          const res = await client.callTool({
            name: "execute",
            arguments: { code: CODE },
          });
          assert.isFalse(Boolean(res.isError), JSON.stringify(res.content));
          assert.equals((res.structuredContent as { result: unknown }).result, {
            listed: 1,
            name: "Rex",
            created: 2,
          });
        } finally {
          await stop();
          await api.close();
        }

        const calls = api.requests;
        assert.equals(
          calls.map((r) => `${r.method} ${r.path}`),
          ["GET /v1/pets", "GET /v1/pets/1", "POST /v1/pets"],
        );
        if (token) {
          refute.contains(JSON.stringify(calls), token);
        }

        const allowed = readLogRecords(path.join(dir, "oag-mcp.log")).filter(
          (r) => r.event === "authorization.allowed",
        );
        assert.equals(allowed.length, 3);
        for (const r of allowed) {
          const raw = r.raw as {
            actor: { user: { uid: string } };
            unmapped: { schemes: string[] };
          };
          assert.equals(raw.actor.user.uid, principal(mcp));
          assert.equals(
            raw.unmapped.schemes,
            upstream.scheme ? [upstream.scheme] : [],
          );
        }
      });
    });
  }
}
