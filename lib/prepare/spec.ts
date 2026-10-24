"use strict";
/**
 * Load an OpenAPI 3.x document and extract the operations, security schemes
 * and documentation used for indexing and for the runtime request broker.
 *
 * External `$ref`s are resolved from the local filesystem only: HTTP
 * resolution is disabled so builds never contact remote hosts.
 *
 * @module prepare/spec
 */
import SwaggerParser from "@apidevtools/swagger-parser";
import { sample } from "openapi-sampler";

import { OagMcpError } from "../errors.js";
import type {
  ParameterInfo,
  SecurityRequirement,
  SecuritySchemeInfo,
  SpecOperation,
  SpecSummary,
} from "../types.js";

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

type Json = Record<string, unknown>;

/**
 * Convert a schema to a compact human description, e.g. "integer(int64)".
 *
 * @param {Object} schema - OpenAPI schema
 * @param {Number} [depth] - recursion depth
 * @return {String} description
 */
export function describeSchema(schema: unknown, depth = 0): string {
  if (!schema || typeof schema !== "object") {
    return "any";
  }
  const s = schema as Json;
  if (depth > 2) {
    return String(s.type ?? "object");
  }
  if (Array.isArray(s.enum)) {
    return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  const type = Array.isArray(s.type) ? s.type.join("|") : s.type;
  if (type === "array") {
    return `${describeSchema(s.items, depth + 1)}[]`;
  }
  if (type) {
    return s.format ? `${type}(${s.format})` : String(type);
  }
  for (const k of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(s[k])) {
      return (s[k] as unknown[])
        .map((x) => describeSchema(x, depth + 1))
        .join(k === "allOf" ? " & " : " | ");
    }
  }
  return s.properties ? "object" : "any";
}

/**
 * Pick an example value for a schema, using openapi-sampler: the schema's
 * own `example`, `examples`, `default` or first `enum` value where present,
 * otherwise a value generated from its type and format (`oneOf`/`anyOf`,
 * `allOf` and recursive schemas included). Only required properties are
 * included, and `readOnly` properties are left out because the examples are
 * for requests.
 *
 * @param {Object} schema - dereferenced OpenAPI schema
 * @return {*} example value, or undefined when none can be produced
 */
export function exampleForSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  try {
    return sample(schema as Parameters<typeof sample>[0], {
      skipReadOnly: true,
      skipNonRequired: true,
      quiet: true,
    });
  } catch {
    // An example is a convenience; never fail preparation over one.
    return undefined;
  }
}

/**
 * Describe a security scheme and whether oag-mcp supports it for upstream
 * calls.
 *
 * @param {String} name - scheme name
 * @param {Object} scheme - OpenAPI security scheme
 * @return {Object} scheme info
 */
export function describeSecurityScheme(
  name: string,
  scheme: Json,
): SecuritySchemeInfo {
  const type = String(scheme.type ?? "");
  const info: SecuritySchemeInfo = {
    name,
    type: type as SecuritySchemeInfo["type"],
    supported: false,
    description:
      typeof scheme.description === "string" ? scheme.description : undefined,
  };
  if (type === "apiKey") {
    info.in = scheme.in as SecuritySchemeInfo["in"];
    info.paramName = String(scheme.name ?? "");
    if (info.in === "header" || info.in === "query") {
      info.supported = true;
    } else {
      info.unsupportedReason = `apiKey in "${String(scheme.in)}" is not supported (header and query are)`;
    }
  } else if (type === "http") {
    info.scheme = String(scheme.scheme ?? "").toLowerCase();
    info.bearerFormat =
      typeof scheme.bearerFormat === "string" ? scheme.bearerFormat : undefined;
    if (info.scheme === "basic" || info.scheme === "bearer") {
      info.supported = true;
    } else {
      info.unsupportedReason = `HTTP "${info.scheme}" authentication is not supported (basic and bearer are)`;
    }
  } else if (type === "oauth2") {
    const flows = (scheme.flows ?? {}) as Json;
    const cc = flows.clientCredentials as Json | undefined;
    info.flows = Object.keys(flows);
    if (cc && typeof cc.tokenUrl === "string") {
      info.supported = true;
      info.tokenUrl = cc.tokenUrl;
      info.scopes = Object.keys((cc.scopes ?? {}) as Json);
    } else {
      info.unsupportedReason = `OAuth2 flows [${info.flows.join(", ")}] are not supported; only clientCredentials is (interactive login is out of scope)`;
    }
  } else if (type === "openIdConnect") {
    info.unsupportedReason =
      "openIdConnect is not supported for upstream calls (interactive login is out of scope)";
  } else if (type === "mutualTLS") {
    info.unsupportedReason = "mutualTLS is not supported for upstream calls";
  } else {
    info.unsupportedReason = `Unknown security scheme type "${type}"`;
  }
  return info;
}

/**
 * Resolve the first server URL, substituting variable defaults.
 *
 * @param {Array} servers - OpenAPI servers
 * @return {String|undefined} URL
 * @private
 */
function _serverUrls(servers: unknown): string[] {
  if (!Array.isArray(servers)) {
    return [];
  }
  return servers
    .filter((s) => s && typeof s.url === "string")
    .map((s) => {
      let url = s.url as string;
      const vars = (s.variables ?? {}) as Record<string, { default?: string }>;
      for (const [k, v] of Object.entries(vars)) {
        url = url.split(`{${k}}`).join(String(v.default ?? ""));
      }
      return url.replace(/\/+$/, "");
    });
}

/**
 * Normalise a security requirement list.
 *
 * @param {Array} security - OpenAPI security requirement objects
 * @return {Array} requirements
 * @private
 */
function _security(security: unknown): SecurityRequirement[] | undefined {
  if (!Array.isArray(security)) {
    return undefined;
  }
  return security.map((req) => {
    const out: SecurityRequirement = {};
    for (const [k, v] of Object.entries((req ?? {}) as Json)) {
      out[k] = Array.isArray(v) ? v.map(String) : [];
    }
    return out;
  });
}

/**
 * Load, validate and summarise an OpenAPI document.
 *
 * @param {String} specPath - path to the OpenAPI YAML/JSON document
 * @return {Promise} spec summary
 */
export async function loadSpec(specPath: string): Promise<SpecSummary> {
  let api: Json;
  try {
    api = (await SwaggerParser.validate(specPath, {
      resolve: { http: false },
    })) as unknown as Json;
  } catch (err) {
    throw new OagMcpError(
      "SPEC_INVALID",
      `OpenAPI document ${specPath} could not be loaded: ${(err as Error).message}`,
      {
        hint: "Check the document is valid OpenAPI 3.0/3.1. Remote $ref URLs are not fetched; vendor them as local files.",
        cause: err,
      },
    );
  }
  const version = String(api.openapi ?? api.swagger ?? "");
  if (!/^3\.[01]\./.test(version)) {
    throw new OagMcpError(
      "SPEC_VERSION_UNSUPPORTED",
      `OpenAPI version "${version}" is not supported`,
      {
        hint: "oag-mcp supports OpenAPI 3.0.x and 3.1.x documents. Convert Swagger 2.0 documents first (e.g. with swagger2openapi).",
      },
    );
  }
  const info = (api.info ?? {}) as Json;
  const components = (api.components ?? {}) as Json;
  const schemes: Record<string, SecuritySchemeInfo> = {};
  for (const [name, scheme] of Object.entries(
    (components.securitySchemes ?? {}) as Json,
  )) {
    schemes[name] = describeSecurityScheme(name, scheme as Json);
  }
  const globalSecurity = _security(api.security) ?? [];
  const operations: SpecOperation[] = [];
  for (const [p, item] of Object.entries((api.paths ?? {}) as Json)) {
    const pathItem = (item ?? {}) as Json;
    const shared = Array.isArray(pathItem.parameters)
      ? (pathItem.parameters as Json[])
      : [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as Json | undefined;
      if (!op) {
        continue;
      }
      const params = new Map<string, Json>();
      for (const prm of [...shared, ...((op.parameters as Json[]) ?? [])]) {
        params.set(`${prm.in}:${prm.name}`, prm);
      }
      const parameters: ParameterInfo[] = [...params.values()].map((prm) => {
        const schema = (prm.schema ?? {}) as Json;
        return {
          name: String(prm.name),
          in: String(prm.in) as ParameterInfo["in"],
          required: Boolean(prm.required),
          description:
            typeof prm.description === "string" ? prm.description : undefined,
          schemaType: describeSchema(schema),
          example:
            prm.example !== undefined ? prm.example : exampleForSchema(schema),
        };
      });
      const explicit = _security(op.security);
      let requestBody: SpecOperation["requestBody"];
      if (op.requestBody && typeof op.requestBody === "object") {
        const rb = op.requestBody as Json;
        const content = (rb.content ?? {}) as Json;
        const firstType = Object.keys(content)[0];
        const media = (firstType ? content[firstType] : {}) as Json;
        requestBody = {
          required: Boolean(rb.required),
          contentTypes: Object.keys(content),
          description:
            typeof rb.description === "string" ? rb.description : undefined,
          schemaType: describeSchema(media.schema),
          example:
            media.example !== undefined
              ? media.example
              : exampleForSchema(media.schema),
        };
      }
      const responses: Record<string, string> = {};
      for (const [code, r] of Object.entries((op.responses ?? {}) as Json)) {
        const desc = (r as Json)?.description;
        responses[code] = typeof desc === "string" ? desc : "";
      }
      operations.push({
        key: `${method.toUpperCase()} ${p}`,
        method: method.toUpperCase(),
        path: p,
        operationId:
          typeof op.operationId === "string" ? op.operationId : undefined,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        summary: typeof op.summary === "string" ? op.summary : undefined,
        description:
          typeof op.description === "string" ? op.description : undefined,
        deprecated: Boolean(op.deprecated),
        parameters,
        requestBody,
        responses,
        security: explicit ?? globalSecurity,
        securityIsOverride: explicit !== undefined,
      });
    }
  }
  const tags = Array.isArray(api.tags)
    ? (api.tags as Json[]).map((t) => ({
        name: String(t.name),
        description:
          typeof t.description === "string" ? t.description : undefined,
      }))
    : [];
  return {
    openapiVersion: version,
    title: String(info.title ?? "API"),
    apiVersion: String(info.version ?? ""),
    description:
      typeof info.description === "string" ? info.description : undefined,
    servers: _serverUrls(api.servers),
    tags,
    securitySchemes: schemes,
    globalSecurity,
    operations,
  };
}
