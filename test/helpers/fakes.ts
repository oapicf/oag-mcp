"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Logs } from "../../lib/logging/logger.js";
import type { SecuritySchemeInfo } from "../../lib/types.js";

/** Logs writing to a throwaway file so tests stay quiet. */
export function quietLogs(): {
  logs: Logs;
  file: string;
  records: () => Array<Record<string, unknown>>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-quiet-"));
  const file = path.join(dir, "all.log");
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

/** Security schemes matching the fixture spec. */
export const SCHEMES: Record<string, SecuritySchemeInfo> = {
  apiKeyHeader: {
    name: "apiKeyHeader",
    type: "apiKey",
    in: "header",
    paramName: "X-Api-Key",
    supported: true,
  },
  apiKeyQuery: {
    name: "apiKeyQuery",
    type: "apiKey",
    in: "query",
    paramName: "api_key",
    supported: true,
  },
  bearerAuth: {
    name: "bearerAuth",
    type: "http",
    scheme: "bearer",
    supported: true,
  },
  adminBasic: {
    name: "adminBasic",
    type: "http",
    scheme: "basic",
    supported: true,
  },
  clinicOAuth: {
    name: "clinicOAuth",
    type: "oauth2",
    flows: ["clientCredentials"],
    tokenUrl: "http://127.0.0.1:4011/token",
    scopes: ["pets:write"],
    supported: true,
  },
  oidc: {
    name: "oidc",
    type: "openIdConnect",
    supported: false,
    unsupportedReason: "nope",
  },
};

/** A scripted fetch that records calls. */
export function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch & { calls: Array<{ url: URL; init: RequestInit }> } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
