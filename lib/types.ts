"use strict";
/**
 * Shared data types for SDK preparation, the search index and the runtime.
 *
 * @module types
 */

/** An OpenAPI security requirement: scheme name to required scopes. */
export type SecurityRequirement = Record<string, string[]>;

/** An OpenAPI security scheme and whether oag-mcp supports it upstream. */
export interface SecuritySchemeInfo {
  name: string;
  type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
  supported: boolean;
  unsupportedReason?: string;
  description?: string;
  /** apiKey location. */
  in?: "header" | "query" | "cookie";
  /** apiKey header or query parameter name. */
  paramName?: string;
  /** http scheme, lower-cased ("basic", "bearer"). */
  scheme?: string;
  bearerFormat?: string;
  /** oauth2 flows declared. */
  flows?: string[];
  /** oauth2 clientCredentials token URL. */
  tokenUrl?: string;
  /** oauth2 clientCredentials scopes declared. */
  scopes?: string[];
}

/** An OpenAPI parameter, summarised. */
export interface ParameterInfo {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schemaType: string;
  example?: unknown;
}

/** An OpenAPI operation, summarised. */
export interface SpecOperation {
  /** "GET /pets/{petId}" */
  key: string;
  method: string;
  path: string;
  operationId?: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated: boolean;
  parameters: ParameterInfo[];
  requestBody?: {
    required: boolean;
    contentTypes: string[];
    description?: string;
    schemaType: string;
    example?: unknown;
  };
  responses: Record<string, string>;
  /** Effective requirement alternatives (operation override or global). */
  security: SecurityRequirement[];
  /** True when the operation declared its own `security`. */
  securityIsOverride: boolean;
}

/** Summary of an OpenAPI document. */
export interface SpecSummary {
  openapiVersion: string;
  title: string;
  apiVersion: string;
  description?: string;
  servers: string[];
  tags: Array<{ name: string; description?: string }>;
  securitySchemes: Record<string, SecuritySchemeInfo>;
  globalSecurity: SecurityRequirement[];
  operations: SpecOperation[];
}

/** A named TypeScript declaration referenced by an SDK method. */
export interface TypeDeclaration {
  name: string;
  declaration: string;
}

/** Authentication requirements of a method, as seen by an agent. */
export interface AuthSummary {
  /** Alternatives; any one satisfies the requirement. Empty = none. */
  alternatives: Array<{
    schemes: Array<{ name: string; type: string; scopes: string[] }>;
  }>;
  /** True when one alternative requires no authentication. */
  optional: boolean;
  /** Schemes referenced by this operation that oag-mcp cannot satisfy. */
  unsupportedSchemes: string[];
}

/**
 * An SDK method bound to an OpenAPI operation. This is what `search`
 * returns and what `execute` exposes as `sdk.<className>.<methodName>`.
 */
export interface MethodRecord {
  /** Stable identifier: "<ApiClass>.<method>". */
  id: string;
  className: string;
  methodName: string;
  /** Exposed path in execute code, e.g. "sdk.PetsApi.listPets". */
  sdkPath: string;
  operationId?: string;
  httpMethod: string;
  path: string;
  tags: string[];
  summary?: string;
  description?: string;
  deprecated: boolean;
  /** Full method signature as declared by the SDK. */
  signature: string;
  /** Parameter list as declared by the SDK. */
  parameters: Array<{ name: string; type: string; optional: boolean }>;
  /** Request parameter interface, when the method takes one. */
  inputType?: TypeDeclaration;
  /** Declared return type, e.g. "Promise<Array<Pet>>". */
  returnType: string;
  /** Declarations of SDK types referenced by inputs and outputs. */
  referencedTypes: TypeDeclaration[];
  /** Required argument names (SDK naming). */
  requiredArguments: string[];
  /** OpenAPI parameters (OpenAPI naming) for documentation. */
  apiParameters: ParameterInfo[];
  requestBody?: SpecOperation["requestBody"];
  responses: Record<string, string>;
  auth: AuthSummary;
  security: SecurityRequirement[];
  /** Example execute code calling this method. */
  example: string;
}

/** Minimal operation data used by the runtime request broker. */
export interface OperationBinding {
  id: string;
  className: string;
  methodName: string;
  httpMethod: string;
  path: string;
  operationId?: string;
  tags: string[];
  security: SecurityRequirement[];
}

/**
 * Description of an SDK prepared at server start-up (in memory; never
 * written as a user-managed artifact).
 */
export interface PreparedSdkInfo {
  /** Random id of this preparation (one per server process). */
  prepareId: string;
  preparedAt: string;
  oagMcpVersion: string;
  target: {
    generator: "typescript-fetch";
    oagVersion: string;
    oagVersionTested: boolean;
    /** Generator options detected from the SDK sources. */
    options: Record<string, string | boolean>;
    sdkLayout: "source" | "compiled";
    sdkPackage?: { name?: string; version?: string };
  };
  tools: { typescript: string; esbuild: string };
  inputs: {
    spec: { fileName: string; sha256: string };
    sdk: { kind: "directory" | "archive"; sha256: string };
  };
  api: {
    title: string;
    version: string;
    description?: string;
    servers: string[];
    tags: Array<{ name: string; description?: string }>;
  };
  securitySchemes: Record<string, SecuritySchemeInfo>;
  operations: OperationBinding[];
  unmappedOperations: Array<{ key: string; operationId?: string }>;
}
