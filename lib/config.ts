"use strict";
/**
 * Configuration for `oag-mcp serve`, read from the `--config` file.
 *
 * The configuration file never contains secret values. Secrets are
 * referenced either by environment variable name (`{ env: NAME }`) or by key
 * in a protected local secrets file (`{ secret: key }`). Two independent
 * namespaces keep MCP access control (`mcpAuth`) separate from upstream API
 * credentials (`upstreamAuth`).
 *
 * @module config
 */
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import * as z from "zod";

import { OagMcpError } from "./errors.js";
import { LOG_LEVELS } from "./logging/logger.js";

/** Reference to a secret value. */
export const SecretRef = z.union([
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ secret: z.string().min(1) }).strict(),
]);
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * The browser origin a value names, `scheme://host[:port]` as browsers send
 * it in the Origin header (default ports omitted), or undefined when the
 * value is not an origin: unparseable, or with credentials, a path, a query
 * or a fragment.
 *
 * @param {String} value - an origin, e.g. https://app.example.com
 * @return {String} the normalised origin
 */
export function browserOrigin(value: string): string | undefined {
  const u = _url(value);
  return u && _isBareOrigin(u, value) ? `${u.protocol}//${u.host}` : undefined;
}

/**
 * A URL, or undefined when the value does not parse as one.
 *
 * @private
 */
function _url(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Whether a URL is only an origin: a host, and no credentials, path, query
 * or fragment (an empty `?` or `#` included).
 *
 * @private
 */
function _isBareOrigin(u: URL, value: string): boolean {
  return (
    Boolean(u.host) &&
    !u.username &&
    !u.password &&
    (u.pathname === "" || u.pathname === "/") &&
    !u.search &&
    !u.hash &&
    !/[?#]$/.test(value)
  );
}

const UpstreamSchemeConfig = z
  .object({
    /** apiKey schemes */
    apiKey: SecretRef.optional(),
    /** http basic */
    username: SecretRef.optional(),
    password: SecretRef.optional(),
    /** http bearer */
    token: SecretRef.optional(),
    /** oauth2 client credentials */
    clientId: SecretRef.optional(),
    clientSecret: SecretRef.optional(),
    tokenUrl: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
    audience: z.string().optional(),
    clientAuthMethod: z
      .enum(["client_secret_basic", "client_secret_post"])
      .optional(),
  })
  .strict();
export type UpstreamSchemeConfig = z.infer<typeof UpstreamSchemeConfig>;

const AuthorizationRule = z
  .object({
    id: z.string().min(1),
    principals: z.array(z.string()).optional(),
    scopes: z.array(z.string()).optional(),
    clientIds: z.array(z.string()).optional(),
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  })
  .strict();
export type AuthorizationRule = z.infer<typeof AuthorizationRule>;

export const ConfigSchema = z
  .object({
    upstream: z
      .object({
        baseUrl: z.string().url().optional(),
        allowedOrigins: z.array(z.string().url()).default([]),
        followRedirects: z.boolean().default(true),
        maxRedirects: z.number().int().min(0).max(10).default(3),
        timeoutMs: z.number().int().min(100).max(300000).default(15000),
        maxResponseBytes: z
          .number()
          .int()
          .min(1024)
          .default(5 * 1024 * 1024),
        maxRequestBytes: z
          .number()
          .int()
          .min(1024)
          .default(1024 * 1024),
      })
      .strict()
      .default({
        allowedOrigins: [],
        followRedirects: true,
        maxRedirects: 3,
        timeoutMs: 15000,
        maxResponseBytes: 5 * 1024 * 1024,
        maxRequestBytes: 1024 * 1024,
      }),
    upstreamAuth: z
      .object({
        provider: z.literal("service-identity").default("service-identity"),
        secretsFile: z.string().optional(),
        allowInsecureTokenUrl: z.boolean().default(false),
        schemes: z.record(z.string(), UpstreamSchemeConfig).default({}),
      })
      .strict()
      .default({
        provider: "service-identity",
        allowInsecureTokenUrl: false,
        schemes: {},
      }),
    mcpAuth: z
      .object({
        mode: z.enum(["none", "static-bearer", "oauth"]).default("none"),
        stdio: z
          .object({
            principal: z.string().default("local"),
            scopes: z.array(z.string()).default([]),
          })
          .strict()
          .default({ principal: "local", scopes: [] }),
        staticBearer: z
          .object({
            tokens: z
              .array(
                z
                  .object({
                    principal: z.string().min(1),
                    token: SecretRef,
                    scopes: z.array(z.string()).default([]),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict()
          .optional(),
        oauth: z
          .object({
            issuer: z.string().url(),
            jwksUri: z.string().url().optional(),
            audience: z.array(z.string()).optional(),
            resource: z.string().url().optional(),
            requiredScopes: z.array(z.string()).default([]),
            scopesSupported: z.array(z.string()).optional(),
            algorithms: z
              .array(z.string())
              .default(["RS256", "PS256", "ES256", "EdDSA"]),
            clockToleranceSec: z.number().int().min(0).max(300).default(30),
            introspection: z
              .object({
                endpoint: z.string().url(),
                clientId: SecretRef,
                clientSecret: SecretRef,
              })
              .strict()
              .optional(),
            allowInsecureIssuer: z.boolean().default(false),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ mode: "none", stdio: { principal: "local", scopes: [] } }),
    authorization: z
      .object({
        default: z.enum(["allow", "deny"]).default("deny"),
        rules: z.array(AuthorizationRule).default([]),
      })
      .strict()
      .optional(),
    execution: z
      .object({
        timeoutMs: z.number().int().min(100).default(30000),
        maxTimeoutMs: z.number().int().min(100).default(120000),
        memoryMb: z.number().int().min(32).max(4096).default(256),
        maxConcurrent: z.number().int().min(1).max(64).default(4),
        maxQueue: z.number().int().min(0).max(1000).default(16),
        maxSdkCalls: z.number().int().min(1).default(200),
        maxResultBytes: z.number().int().min(256).default(65536),
        maxLogBytes: z.number().int().min(0).default(16384),
        maxCodeBytes: z.number().int().min(256).default(100000),
        typecheck: z.boolean().default(true),
        denoPath: z.string().optional(),
      })
      .strict()
      .default({
        timeoutMs: 30000,
        maxTimeoutMs: 120000,
        memoryMb: 256,
        maxConcurrent: 4,
        maxQueue: 16,
        maxSdkCalls: 200,
        maxResultBytes: 65536,
        maxLogBytes: 16384,
        maxCodeBytes: 100000,
        typecheck: true,
      }),
    http: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(3000),
        path: z.string().startsWith("/").default("/mcp"),
        publicUrl: z.string().url().optional(),
        allowedHosts: z.array(z.string()).default([]),
        allowedOrigins: z
          .array(
            z.string().refine((v) => browserOrigin(v) !== undefined, {
              message:
                "must be an origin such as https://app.example.com: scheme, host and optional port, without a path",
            }),
          )
          .default([]),
        maxBodyBytes: z
          .number()
          .int()
          .min(1024)
          .default(1024 * 1024),
      })
      .strict()
      .default({
        host: "127.0.0.1",
        port: 3000,
        path: "/mcp",
        allowedHosts: [],
        allowedOrigins: [],
        maxBodyBytes: 1024 * 1024,
      }),
    logging: z
      .object({
        level: z.enum(LOG_LEVELS).optional(),
        format: z.enum(["json", "pretty"]).optional(),
        file: z.string().optional(),
        auditFile: z.string().optional(),
        auditFailClosed: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parse and validate a configuration object.
 *
 * @param {Object} raw - configuration object
 * @param {String} [source] - file name for messages
 * @return {Object} validated configuration
 */
export function parseConfig(raw: unknown, source = "config"): Config {
  const res = ConfigSchema.safeParse(raw ?? {});
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new OagMcpError(
      "CONFIG_INVALID",
      `Invalid configuration in ${source}: ${issues}`,
      {
        hint: "See docs/configuration.md. Secret values must be referenced with { env: NAME } or { secret: key }, never written inline.",
      },
    );
  }
  return res.data;
}

/**
 * Load a configuration file (YAML or JSON).
 *
 * @param {String} [file] - path; undefined yields defaults
 * @return {Object} { config, baseDir }
 */
export function loadConfig(file?: string): {
  config: Config;
  baseDir: string;
} {
  if (!file) {
    return { config: parseConfig({}), baseDir: process.cwd() };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new OagMcpError(
      "CONFIG_NOT_FOUND",
      `Cannot read configuration file ${file}`,
      { cause: err },
    );
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new OagMcpError(
      "CONFIG_INVALID",
      `Configuration file ${file} is not valid YAML/JSON: ${(err as Error).message}`,
    );
  }
  return {
    config: parseConfig(raw, file),
    baseDir: path.dirname(path.resolve(file)),
  };
}
