"use strict";
/**
 * Write security audit records for OCSF conformance checking
 * (`make -f Makefile-extras test-ocsf`).
 *
 * Two sets of records go to the given file:
 *
 * 1. Every audit event, logged through the real logger with representative
 *    fields, including each class's variants (stdio and HTTP callers,
 *    upstream tokens, SDK operations per HTTP method, sandbox processes).
 * 2. The records of real executions against the mock API: allowed, denied
 *    and forged calls, sandbox capability and import denials, a timeout and
 *    an output limit.
 *
 * Usage: tsx test-integration/helpers/ocsf-events.ts <audit.jsonl>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Logs } from "../../lib/logging/logger.js";
import { AUDIT_EVENTS, type AuditEvent } from "../../lib/logging/ocsf.js";
import { startAuthServer } from "./auth-server.js";
import { LOCAL, configFor, defaultPrepared, service } from "./env.js";
import { startMockApi } from "./mock-api.js";

type Case = [
  AuditEvent,
  Parameters<Logs["audit"]>[1],
  Record<string, unknown>,
  Parameters<Logs["audit"]>[3],
  Logs,
];

/**
 * Log every audit event at least once.
 *
 * @private
 */
function _everyEvent(logs: Logs): void {
  const http = logs.child({
    requestId: "req_http",
    transport: "streamable-http",
    clientAddress: "127.0.0.1",
    clientPort: 51234,
    principalId: "static:reader",
    mcpSessionId: "session-1",
    jsonrpcRequestId: 7,
    toolName: "execute",
  });
  const exec = http.child({ executionId: "exec_1" });
  const stdio = logs.child({
    requestId: "req_stdio",
    transport: "stdio",
    principalId: "local",
  });
  const anonymous = logs.child({
    requestId: "req_anon",
    transport: "streamable-http",
    clientAddress: "::1",
  });
  const op = {
    operation: "PetsApi.listPets",
    operationId: "listPets",
    httpMethod: "GET",
    pathTemplate: "/pets",
  };
  const token = { scheme: "oauth2cc", provider: "service-identity" };
  const cases: Case[] = [
    [
      "authentication.mode_configured",
      "success",
      { mode: "oauth" },
      "info",
      logs,
    ],
    [
      "authentication.succeeded",
      "success",
      { mode: "static-bearer" },
      "info",
      http,
    ],
    [
      "authentication.succeeded",
      "success",
      { mode: "stdio-process-boundary" },
      "info",
      stdio,
    ],
    [
      "authentication.failed",
      "failure",
      { mode: "oauth", reason: "expired" },
      "warn",
      anonymous,
    ],
    ["authentication.token_in_url_rejected", "denied", {}, "warn", anonymous],
    [
      "upstream.token.issue",
      "success",
      { ...token, durationMs: 12 },
      "info",
      exec,
    ],
    [
      "upstream.token.issue_failed",
      "failure",
      { ...token, status: 401 },
      "warn",
      exec,
    ],
    ["upstream.token.refresh", "success", token, "info", exec],
    [
      "upstream.token.refresh_failed",
      "failure",
      { ...token, error: "TypeError" },
      "warn",
      exec,
    ],
    ["upstream.token.invalidated", "success", token, "info", exec],
    ["authorization.policy_loaded", "success", { rules: 2 }, "info", logs],
    [
      "authorization.allowed",
      "allowed",
      { ...op, policyId: "readers", schemes: ["apiKey"] },
      "info",
      exec,
    ],
    [
      "authorization.allowed",
      "allowed",
      { ...op, httpMethod: "POST", strippedCredentials: ["authorization"] },
      "warn",
      exec,
    ],
    [
      "authorization.denied",
      "denied",
      { ...op, httpMethod: "DELETE", policyId: "default" },
      "warn",
      exec,
    ],
    [
      "credential.provider.configured",
      "success",
      { provider: "service-identity" },
      "info",
      logs,
    ],
    [
      "credential.config_invalid",
      "failure",
      { problems: ["clientSecret"] },
      "error",
      logs,
    ],
    [
      "credential.lookup_failed",
      "failure",
      { ...op, httpMethod: "PATCH", reason: "missing_secret" },
      "warn",
      exec,
    ],
    ["execution.policy.applied", "success", { timeoutMs: 1000 }, "info", logs],
    [
      "execution.requested",
      "accepted",
      { language: "typescript" },
      "info",
      exec,
    ],
    [
      "execution.requested",
      "accepted",
      {},
      "info",
      stdio.child({ toolName: "execute" }),
    ],
    ["execution.import_denied", "denied", { violations: 1 }, "warn", exec],
    [
      "execution.resource_limit",
      "denied",
      { limit: "maxCodeBytes" },
      "warn",
      exec,
    ],
    [
      "execution.resource_limit",
      "denied",
      { ...op, limit: "maxResponseBytes" },
      "warn",
      exec,
    ],
    [
      "execution.resource_limit",
      "denied",
      { limit: "memoryMb", pid: 4242 },
      "warn",
      exec,
    ],
    [
      "execution.capability_denied",
      "denied",
      { capability: "net" },
      "warn",
      exec,
    ],
    [
      "execution.timeout",
      "denied",
      { reason: "wall_clock_timeout", pid: 4242 },
      "warn",
      exec,
    ],
    [
      "executor.terminated",
      "terminated",
      { reason: "timeout", pid: 4242 },
      "warn",
      exec,
    ],
    [
      "execution.boundary_violation",
      "denied",
      { reason: "unknown_binding" },
      "warn",
      exec,
    ],
    [
      "network.destination_denied",
      "denied",
      { ...op, destinationOrigin: "https://evil.example.com" },
      "warn",
      exec,
    ],
    [
      "network.destination_denied",
      "denied",
      { ...op, reason: "invalid_url" },
      "warn",
      exec,
    ],
    [
      "network.redirect_denied",
      "denied",
      { ...op, destinationOrigin: "http://10.1.2.3:8080" },
      "warn",
      exec,
    ],
    [
      "transport.host_rejected",
      "denied",
      { httpMethod: "POST" },
      "warn",
      anonymous,
    ],
    [
      "transport.origin_rejected",
      "denied",
      { httpMethod: "OPTIONS" },
      "warn",
      anonymous,
    ],
    [
      "security.config_invalid",
      "failure",
      { errorCode: "MCP_AUTH_CONFIG_INVALID" },
      "error",
      logs,
    ],
    [
      "security.unauthenticated_nonloopback_refused",
      "denied",
      { host: "0.0.0.0" },
      "error",
      logs,
    ],
  ];
  const missing = AUDIT_EVENTS.filter((e) => !cases.some(([c]) => c === e));
  if (missing.length > 0) {
    throw new Error(`No conformance case for: ${missing.join(", ")}`);
  }
  for (const [event, outcome, fields, level, l] of cases) {
    l.audit(event, outcome, fields, level);
  }
}

/**
 * Run real executions and keep their audit records.
 *
 * @private
 */
async function _realExecutions(logs: Logs): Promise<void> {
  const auth = await startAuthServer();
  const api = await startMockApi({ oauthTokens: auth.upstreamTokens });
  try {
    const svc = await service(
      await defaultPrepared(),
      configFor(
        api,
        {
          authorization: {
            default: "allow",
            rules: [{ id: "no-admin", allow: [], deny: ["tag:admin"] }],
          },
        },
        auth,
      ),
      logs,
    );
    const ctx = {
      ...LOCAL,
      transport: "streamable-http" as const,
      clientAddress: "127.0.0.1",
      clientPort: 50000,
      mcpSessionId: "session-2",
      jsonrpcRequestId: 3,
    };
    for (const code of [
      `return (await sdk.PetsApi.listPets({ limit: 1 })).length;`,
      `return await sdk.PetsApi.createPet({ newPet: { name: "S", species: "dog" } });`,
      `await sdk.AdminApi.deletePet({ petId: 1 }); return 1;`,
      `return await sdk.StoreApi.getStoreInventory({ headers: { Authorization: "Bearer agent" } });`,
      `return await fetch("https://example.com");`,
      `await new Promise(() => {});`,
      `import x from "npm:left-pad"; return x;`,
      `return "x".repeat(10_000_000);`,
    ]) {
      await svc.execute({ code, timeoutMs: 1500 }, ctx);
    }
  } finally {
    await api.close();
    await auth.close();
  }
}

const out = process.argv[2];
if (!out) {
  throw new Error("Usage: tsx test-integration/helpers/ocsf-events.ts <file>");
}
fs.rmSync(out, { force: true });
const opFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-ocsf-")),
  "op.log",
);
const logs = new Logs({ file: opFile, auditFile: out });
_everyEvent(logs);
await _realExecutions(logs);
logs.flush();
process.exit(0);
