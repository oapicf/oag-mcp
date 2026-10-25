"use strict";
import referee from "@sinonjs/referee";

import { AUDIT_EVENTS, OCSF_VERSION, toOcsfEvent } from "../lib/ocsf.js";

const { assert, refute, match } = referee;

const PRODUCT = {
  name: "oag-mcp",
  version: "1.2.3",
  vendorName: "Vendor",
  instanceId: "inst_1",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- OCSF JSON
type Event = Record<string, any>;

const event = (
  name: Parameters<typeof toOcsfEvent>[0],
  outcome: Parameters<typeof toOcsfEvent>[1],
  fields: Record<string, unknown> = {},
  level: Parameters<typeof toOcsfEvent>[2] = "info",
): Event => toOcsfEvent(name, outcome, level, fields, PRODUCT, 1000);

describe("ocsf - toOcsfEvent", function () {
  it("should give every audit event a consistent class, category and activity", function () {
    const categories: Record<number, number> = {
      3002: 3,
      6003: 6,
      4002: 4,
      1007: 1,
      6002: 6,
      2004: 2,
    };
    for (const name of AUDIT_EVENTS) {
      const e = event(name, "success", { httpMethod: "GET" });
      assert.equals(e.category_uid, categories[e.class_uid], name);
      assert.equals(e.type_uid, e.class_uid * 100 + e.activity_id, name);
      assert.isString(e.activity_name, name);
      assert.equals(e.type_name, `${e.class_name}: ${e.activity_name}`, name);
      assert.equals(e.metadata.event_code, name);
      assert.equals(e.metadata.version, OCSF_VERSION);
    }
  });

  it("should record the time in milliseconds and as a date-time", function () {
    const e = event("execution.requested", "accepted");
    assert.equals(e.time, 1000);
    assert.equals(e.time_dt, "1970-01-01T00:00:01.000Z");
    assert.contains(e.metadata.profiles, "datetime");
  });

  it("should identify the product and the reporting instance", function () {
    const e = event("execution.requested", "accepted", { requestId: "req_1" });
    assert.equals(e.metadata.product, {
      name: "oag-mcp",
      version: "1.2.3",
      vendor_name: "Vendor",
    });
    assert.equals(e.metadata.reporter, match({ uid: "inst_1" }));
    assert.equals(e.metadata.correlation_uid, "req_1");
  });

  it("should map an SDK operation's HTTP method to the API Activity activity", function () {
    const id = (httpMethod: string) =>
      event("authorization.allowed", "allowed", { httpMethod }).activity_id;
    assert.equals(
      ["POST", "GET", "PUT", "PATCH", "DELETE"].map(id),
      [1, 2, 3, 3, 4],
    );
    assert.equals(
      event("authorization.allowed", "allowed", { httpMethod: "QUERY" })
        .activity_id,
      99,
    );
  });

  it("should record allow and deny decisions with the security control profile", function () {
    const allowed = event("authorization.allowed", "allowed", {
      policyId: "readers",
    });
    assert.equals(allowed.status_id, 1);
    assert.equals(allowed.action_id, 1);
    assert.equals(allowed.disposition_id, 1);
    assert.equals(allowed.policy, { uid: "readers" });
    assert.contains(allowed.metadata.profiles, "security_control");

    const denied = event("authorization.denied", "denied", {}, "warn");
    assert.equals(denied.status_id, 2);
    assert.equals(denied.action_id, 2);
    assert.equals(denied.disposition_id, 2);
    assert.equals(denied.severity_id, 2);

    const plain = event("execution.requested", "accepted");
    assert.isUndefined(plain.action_id);
    refute.contains(plain.metadata.profiles, "security_control");
  });

  it("should mark an allowed request as modified when agent-supplied credentials were removed", function () {
    const e = event("authorization.allowed", "allowed", {
      strippedCredentials: ["authorization"],
    });
    assert.equals(e.action_id, 4);
    assert.equals(e.disposition_id, 11);
    assert.equals(e.unmapped.strippedCredentials, ["authorization"]);
  });

  it("should place known fields in their OCSF attributes and keep the rest unmapped", function () {
    const e = event("authorization.allowed", "allowed", {
      requestId: "req_1",
      executionId: "exec_1",
      principalId: "static:reader",
      clientAddress: "127.0.0.1",
      clientPort: 5000,
      operation: "PetsApi.listPets",
      operationId: "listPets",
      httpMethod: "GET",
      pathTemplate: "/pets",
      reason: "rule_match",
      schemes: ["apiKey"],
    });
    assert.equals(e.actor, { user: { uid: "static:reader" } });
    assert.equals(e.api, {
      operation: "PetsApi.listPets",
      request: { uid: "exec_1" },
      service: { name: "oag-mcp", version: "1.2.3" },
    });
    assert.equals(e.src_endpoint, { ip: "127.0.0.1", port: 5000 });
    assert.equals(e.http_request, {
      http_method: "GET",
      url: { path: "/pets" },
    });
    assert.equals(e.resources, [
      { uid: "listPets", type: "OpenAPI operation" },
    ]);
    assert.equals(e.status_detail, "rule_match");
    assert.equals(e.unmapped, { schemes: ["apiKey"] });
  });

  it("should describe an MCP tool call with the AI operation profile", function () {
    const e = event("execution.requested", "accepted", {
      toolName: "execute",
      mcpSessionId: "sess-1",
    });
    assert.equals(e.message_context, {
      uid: "sess-1",
      name: "tools/call execute",
      ai_role_id: 3,
      ai_role: "Tool",
      service: { name: "oag-mcp", version: "1.2.3" },
    });
    assert.contains(e.metadata.profiles, "ai_operation");
  });

  it("should name the caller as the authenticated user, or as unknown when authentication failed", function () {
    const ok = event("authentication.succeeded", "success", {
      principalId: "static:reader",
      mode: "static-bearer",
      transport: "stdio",
    });
    assert.equals(ok.user, { uid: "static:reader" });
    assert.equals(ok.auth_protocol_id, 99);
    assert.equals(ok.src_endpoint, { name: "stdio" });
    const failed = event("authentication.failed", "failure", { mode: "oauth" });
    assert.equals(failed.user, match({ type_id: 0 }));
    assert.equals(failed.auth_protocol_id, 6);
  });

  it("should record upstream tokens as authentication of oag-mcp's service identity", function () {
    const e = event("upstream.token.issue_failed", "failure", {
      scheme: "oauth2cc",
      provider: "service-identity",
      status: 401,
    });
    assert.equals(e.class_uid, 3002);
    assert.equals(e.activity_name, "Token Issue");
    assert.equals(e.user, {
      uid: "service-identity",
      type_id: 4,
      type: "Service",
    });
    assert.equals(e.service, { name: "oauth2cc" });
    assert.equals(e.status_code, "401");
  });

  it("should describe a denied destination by its endpoint, never its query", function () {
    const e = event("network.destination_denied", "denied", {
      httpMethod: "POST",
      destinationOrigin: "https://evil.example.com",
    });
    assert.equals(e.class_uid, 4002);
    assert.equals(e.activity_id, 6);
    assert.equals(e.dst_endpoint, { hostname: "evil.example.com", port: 443 });
    assert.equals(e.http_request.url, {
      scheme: "https",
      hostname: "evil.example.com",
    });
  });

  it("should identify the sandbox process", function () {
    const e = event("execution.timeout", "denied", {
      pid: 42,
      executionId: "exec_1",
    });
    assert.equals(e.class_uid, 1007);
    assert.equals(e.activity_id, 2);
    assert.equals(e.status_id, 1);
    assert.equals(e.process, { name: "deno", pid: 42, uid: "exec_1" });
    assert.equals(e.device, match({ type_id: 1 }));
  });

  it("should report forged bridge messages as new detection findings", function () {
    const e = event("execution.boundary_violation", "denied", {
      reason: "unknown_binding",
    });
    assert.equals(e.class_uid, 2004);
    assert.equals(e.status, "New");
    assert.equals(e.severity_id, 3);
    assert.isString(e.finding_info.uid);
  });

  it("should record security configuration as application lifecycle events", function () {
    const configured = event("authorization.policy_loaded", "success", {
      rules: 2,
    });
    assert.equals(configured.class_uid, 6002);
    assert.equals(configured.activity_id, 99);
    assert.equals(configured.activity_name, "Configure");
    assert.equals(configured.unmapped, { rules: 2 });
    const refused = event("security.config_invalid", "failure", {
      errorCode: "MCP_AUTH_CONFIG_INVALID",
    });
    assert.equals(refused.activity_id, 3);
    assert.equals(refused.status_id, 2);
    assert.equals(refused.status_code, "MCP_AUTH_CONFIG_INVALID");
  });
});
