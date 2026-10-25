"use strict";
import referee from "@sinonjs/referee";

import {
  otelAttributeName,
  otelRecord,
  otelTimestamp,
  toOtelAttributes,
} from "../lib/otel.js";

const { assert } = referee;

describe("otel - otelAttributeName", function () {
  it("should use the semantic convention attribute when there is one", function () {
    assert.equals(otelAttributeName("httpMethod"), "http.request.method");
    assert.equals(otelAttributeName("status"), "http.response.status_code");
    assert.equals(otelAttributeName("principalId"), "enduser.id");
    assert.equals(otelAttributeName("mcpSessionId"), "mcp.session.id");
    assert.equals(otelAttributeName("errorCode"), "error.type");
  });

  it("should namespace other fields under oag_mcp in snake_case", function () {
    assert.equals(
      otelAttributeName("startupDurationMs"),
      "oag_mcp.startup_duration_ms",
    );
    assert.equals(otelAttributeName("sdkSha256"), "oag_mcp.sdk_sha256");
    assert.equals(otelAttributeName("stage"), "oag_mcp.stage");
  });
});

describe("otel - toOtelAttributes", function () {
  it("should record stdio as a pipe and Streamable HTTP as HTTP over TCP", function () {
    assert.equals(toOtelAttributes({ transport: "stdio" }), {
      "network.transport": "pipe",
    });
    assert.equals(toOtelAttributes({ transport: "streamable-http" }), {
      "network.transport": "tcp",
      "network.protocol.name": "http",
    });
  });

  it("should describe a tool call with the MCP and GenAI attributes", function () {
    assert.equals(toOtelAttributes({ toolName: "search" }), {
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
    });
  });

  it("should drop undefined fields", function () {
    assert.equals(toOtelAttributes({ requestId: undefined, count: 0 }), {
      "oag_mcp.count": 0,
    });
  });
});

describe("otel - otelRecord", function () {
  it("should build a complete log record with nanosecond timestamps", function () {
    const r = otelRecord(
      "error",
      "logging.destination_failed",
      { destination: "file" },
      {
        resource: { "service.name": "oag-mcp" },
        scope: { Name: "oag-mcp.operational" },
      },
    );
    assert.match(r.Timestamp, /^\d{19}$/);
    assert.equals(r.SeverityText, "ERROR");
    assert.equals(r.SeverityNumber, 17);
    assert.equals(r.EventName, "logging.destination_failed");
    assert.equals(r.Body, "logging.destination_failed");
    assert.equals(r.Attributes, { "oag_mcp.destination": "file" });
    assert.equals(otelTimestamp(1234), "1234000000");
  });
});
