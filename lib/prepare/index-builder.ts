"use strict";
/**
 * Merge SDK analysis with OpenAPI operations into method records.
 *
 * Bindings are matched on HTTP method plus path template. Methods that
 * match no operation, or more than one, are reported as errors rather than
 * guessed.
 *
 * @module prepare/index-builder
 */
import { OagMcpError } from "../errors.js";
import type {
  AuthSummary,
  MethodRecord,
  OperationBinding,
  SecurityRequirement,
  SecuritySchemeInfo,
  SpecOperation,
  SpecSummary,
} from "../types.js";
import {
  type AnalyzedMethod,
  type ExampleHints,
  normaliseName,
} from "./analyze.js";

/**
 * Normalise a path template so parameter names do not matter.
 *
 * @param {String} p - path template
 * @return {String} normalised template
 */
export function normalisePathTemplate(p: string): string {
  return p.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/";
}

/**
 * Build example hints for an operation from its OpenAPI parameters and body.
 *
 * @param {Object} op - spec operation
 * @return {Object} hints keyed by normalised name
 */
export function hintsForOperation(op: SpecOperation | undefined): ExampleHints {
  const hints: ExampleHints = {};
  if (!op) {
    return hints;
  }
  for (const p of op.parameters) {
    if (p.example !== undefined) {
      hints[normaliseName(p.name)] = p.example;
    }
  }
  if (op.requestBody?.example !== undefined) {
    hints.__body = op.requestBody.example;
  }
  return hints;
}

/**
 * Summarise authentication requirements for agents.
 *
 * @param {Array} security - effective requirement alternatives
 * @param {Object} schemes - security schemes
 * @return {Object} auth summary
 */
export function summariseAuth(
  security: SecurityRequirement[],
  schemes: Record<string, SecuritySchemeInfo>,
): AuthSummary {
  const unsupported = new Set<string>();
  const alternatives = security
    .filter((req) => Object.keys(req).length > 0)
    .map((req) => ({
      schemes: Object.entries(req).map(([name, scopes]) => {
        const s = schemes[name];
        if (!s || !s.supported) {
          unsupported.add(name);
        }
        const type = s
          ? s.type === "http"
            ? `http-${s.scheme}`
            : s.type === "apiKey"
              ? `apiKey-${s.in}`
              : s.type === "oauth2"
                ? "oauth2-client-credentials"
                : s.type
          : "undefined-scheme";
        return { name, type, scopes };
      }),
    }));
  return {
    alternatives,
    optional:
      security.length === 0 ||
      security.some((r) => Object.keys(r).length === 0),
    unsupportedSchemes: [...unsupported].sort(),
  };
}

/**
 * Build method records and operation bindings.
 *
 * @param {Object} spec - spec summary
 * @param {Array} methods - analysed SDK methods
 * @return {Object} { records, bindings, unmapped }
 */
export function buildRecords(
  spec: SpecSummary,
  methods: AnalyzedMethod[],
): {
  records: MethodRecord[];
  bindings: OperationBinding[];
  unmapped: Array<{ key: string; operationId?: string }>;
} {
  const byKey = new Map<string, SpecOperation>();
  const byNormalised = new Map<string, SpecOperation[]>();
  for (const op of spec.operations) {
    byKey.set(op.key, op);
    const nk = `${op.method} ${normalisePathTemplate(op.path)}`;
    byNormalised.set(nk, [...(byNormalised.get(nk) ?? []), op]);
  }
  const problems: string[] = [];
  const records: MethodRecord[] = [];
  const bound = new Set<string>();
  for (const m of methods) {
    let op = byKey.get(`${m.httpMethod} ${m.path}`);
    if (!op) {
      const candidates =
        byNormalised.get(`${m.httpMethod} ${normalisePathTemplate(m.path)}`) ??
        [];
      if (candidates.length === 1) {
        op = candidates[0];
      } else if (candidates.length > 1) {
        problems.push(
          `${m.className}.${m.methodName} (${m.httpMethod} ${m.path}) matches several operations: ${candidates.map((c) => c.key).join(", ")}`,
        );
        continue;
      } else {
        problems.push(
          `${m.className}.${m.methodName} (${m.httpMethod} ${m.path}) has no matching operation in the spec`,
        );
        continue;
      }
    }
    bound.add(op.key);
    const id = `${m.className}.${m.methodName}`;
    records.push({
      id,
      className: m.className,
      methodName: m.methodName,
      sdkPath: `sdk.${id}`,
      operationId: op.operationId,
      httpMethod: op.method,
      path: op.path,
      tags: op.tags,
      summary: op.summary,
      description: op.description ?? (m.documentation || undefined),
      deprecated: op.deprecated || m.deprecated,
      signature: m.signature,
      parameters: m.parameters,
      inputType: m.inputType,
      returnType: m.returnType,
      referencedTypes: m.referencedTypes,
      requiredArguments: m.requiredArguments,
      apiParameters: op.parameters,
      requestBody: op.requestBody,
      responses: op.responses,
      auth: summariseAuth(op.security, spec.securitySchemes),
      security: op.security,
      example: m.example,
    });
  }
  if (problems.length > 0) {
    throw new OagMcpError(
      "SDK_SPEC_MISMATCH",
      `The SDK does not match the OpenAPI document: ${problems.slice(0, 5).join("; ")}`,
      {
        hint: "Make sure --spec is the document the SDK was generated from (or regenerate the SDK from this document), then restart oag-mcp.",
        details: { problems },
      },
    );
  }
  if (records.length === 0) {
    throw new OagMcpError(
      "SDK_NO_METHODS",
      "No SDK methods could be bound to OpenAPI operations",
    );
  }
  const unmapped = spec.operations
    .filter((op) => !bound.has(op.key))
    .map((op) => ({ key: op.key, operationId: op.operationId }));
  const bindings: OperationBinding[] = records.map((r) => ({
    id: r.id,
    className: r.className,
    methodName: r.methodName,
    httpMethod: r.httpMethod,
    path: r.path,
    operationId: r.operationId,
    tags: r.tags,
    security: r.security,
  }));
  return { records, bindings, unmapped };
}
