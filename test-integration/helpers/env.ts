"use strict";
/**
 * Shared integration-test environment: fixture paths, SDK preparations
 * shared across tests (one per input combination, as a server process would
 * hold), and service/CLI helpers.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig, type Config } from "../../lib/config.js";
import { Logs } from "../../lib/logger.js";
import {
  type PrepareOptions,
  type PreparedSdk,
  prepareSdk,
} from "../../lib/prepare/prepare.js";
import { OagMcpService } from "../../lib/server/service.js";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  API_KEY,
  BEARER_TOKEN,
  type MockApi,
} from "./mock-api.js";
import {
  UPSTREAM_CLIENT_ID,
  UPSTREAM_CLIENT_SECRET,
  type AuthServer,
} from "./auth-server.js";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const FIXTURES = path.join(ROOT, "test", "fixtures", "petclinic");
export const SPEC = path.join(FIXTURES, "openapi.yaml");
export const SDK_726 = path.join(FIXTURES, "sdk-7.26.0");
export const SDK_VARIANT = path.join(FIXTURES, "sdk-variant-7.26.0");
export const SDK_TGZ = path.join(FIXTURES, "petclinic-sdk-1.2.0.tgz");
export const BIN = path.join(ROOT, "bin", "oag-mcp.js");

/** `serve` input options for the default fixture. */
export const SERVE_ARGS = ["--spec", SPEC, "--sdk", SDK_726];

/** Environment variables carrying upstream secrets for tests. */
export const SECRET_ENV = {
  PC_API_KEY: API_KEY,
  PC_BEARER: BEARER_TOKEN,
  PC_ADMIN_USER: ADMIN_USER,
  PC_ADMIN_PASS: ADMIN_PASSWORD,
  PC_CLIENT_ID: UPSTREAM_CLIENT_ID,
  PC_CLIENT_SECRET: UPSTREAM_CLIENT_SECRET,
};
Object.assign(process.env, SECRET_ENV);

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-it-"));
const preparations = new Map<string, Promise<PreparedSdk>>();

/** Quiet logger for builds. */
export function fileLogs(name = "it"): {
  logs: Logs;
  file: string;
  records: () => Array<Record<string, unknown>>;
} {
  const file = path.join(
    WORK,
    `${name}-${Math.random().toString(36).slice(2)}.log`,
  );
  const logs = new Logs({ file, auditFile: file, level: "debug" });
  return {
    logs,
    file,
    records: () =>
      fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}

/**
 * Prepare (once per test run and key) an SDK, as one server process would.
 *
 * @param {String} key - cache key
 * @param {Object} opts - preparation options without logs
 * @return {Promise} prepared SDK
 */
export function prepared(
  key: string,
  opts: Omit<PrepareOptions, "logs">,
): Promise<PreparedSdk> {
  let p = preparations.get(key);
  if (!p) {
    p = prepareSdk({ ...opts, logs: fileLogs(`prepare-${key}`).logs });
    preparations.set(key, p);
  }
  return p;
}

/** The default preparation of the 7.26.0 source fixture. */
export const defaultPrepared = () =>
  prepared("source-7.26.0", { spec: SPEC, sdk: SDK_726 });

/** Work directory for tests. */
export function workDir(name: string): string {
  const d = path.join(WORK, `${name}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Upstream auth configuration covering every fixture scheme. */
export function upstreamAuthConfig(auth?: AuthServer): Record<string, unknown> {
  return {
    allowInsecureTokenUrl: true,
    schemes: {
      apiKeyHeader: { apiKey: { env: "PC_API_KEY" } },
      apiKeyQuery: { apiKey: { env: "PC_API_KEY" } },
      bearerAuth: { token: { env: "PC_BEARER" } },
      adminBasic: {
        username: { env: "PC_ADMIN_USER" },
        password: { env: "PC_ADMIN_PASS" },
      },
      ...(auth
        ? {
            clinicOAuth: {
              clientId: { env: "PC_CLIENT_ID" },
              clientSecret: { env: "PC_CLIENT_SECRET" },
              tokenUrl: auth.tokenUrl,
            },
          }
        : {}),
    },
  };
}

/** Configuration against the mock API. */
export function configFor(
  api: MockApi,
  extra: Record<string, unknown> = {},
  auth?: AuthServer,
): Config {
  return parseConfig({
    upstream: { baseUrl: api.baseUrl },
    upstreamAuth: upstreamAuthConfig(auth),
    ...extra,
  });
}

/** Create a service for a prepared SDK. */
export async function service(
  sdk: PreparedSdk,
  config: Config,
  logs?: Logs,
): Promise<OagMcpService> {
  return OagMcpService.create({
    prepared: sdk,
    config,
    configBaseDir: process.cwd(),
    logs: logs ?? fileLogs("svc").logs,
  });
}

/** A local principal context. */
export const LOCAL = {
  principal: {
    id: "local:test",
    kind: "local" as const,
    name: "test",
    scopes: [],
  },
  requestId: "req_test",
  transport: "stdio" as const,
};

/** Write a YAML/JSON configuration file. */
export function writeConfig(
  dir: string,
  config: Record<string, unknown>,
): string {
  const file = path.join(dir, "oag-mcp.config.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** Start `oag-mcp serve` over Streamable HTTP and wait until it listens. */
export async function startHttpServer(
  args: string[],
  env: Record<string, string> = {},
): Promise<{
  child: ChildProcess;
  url: string;
  stderr: () => string;
  stop: () => Promise<void>;
}> {
  const portArgs = args.includes("--port") ? [] : ["--port", "0"];
  const child = spawn(
    process.execPath,
    [BIN, "serve", ...args, "--transport", "streamable-http", ...portArgs],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not start: ${stderr}`)),
      30000,
    );
    const check = () => {
      const m = /oag-mcp listening on (\S+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr!.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${stderr}`));
    });
  });
  return {
    child,
    url,
    stderr: () => stderr,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.on("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** Run the CLI and capture output. */
export function runCli(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180000,
  });
  return { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
}
