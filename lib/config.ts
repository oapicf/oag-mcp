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
import { LOG_LEVELS } from "./logger.js";

/** Reference to a secret value. */
export const SecretRef = z.union([
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ secret: z.string().min(1) }).strict(),
]);
export type SecretRef = z.infer<typeof SecretRef>;

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
        allowedOrigins: z.array(z.string()).default([]),
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

/**
 * Resolves secret references from the environment and a secrets file.
 */
export class SecretResolver {
  private fileSecrets?: Record<string, string>;

  /**
   * @param {Object} opts - options
   * @param {String} [opts.secretsFile] - path to the secrets file
   * @param {String} opts.baseDir - base for relative paths
   * @param {Object} [opts.env] - environment (defaults to process.env)
   */
  constructor(
    private readonly opts: {
      secretsFile?: string;
      baseDir: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  /**
   * Load the secrets file, enforcing owner-only permissions on POSIX.
   *
   * @private
   */
  private _load(): Record<string, string> {
    if (this.fileSecrets) {
      return this.fileSecrets;
    }
    if (!this.opts.secretsFile) {
      throw new OagMcpError(
        "SECRETS_FILE_MISSING",
        "A { secret: ... } reference was used but upstreamAuth.secretsFile is not configured",
      );
    }
    const file = path.resolve(this.opts.baseDir, this.opts.secretsFile);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      throw new OagMcpError(
        "SECRETS_FILE_MISSING",
        `Secrets file ${file} cannot be read`,
        { cause: err },
      );
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new OagMcpError(
        "SECRETS_FILE_PERMISSIONS",
        `Secrets file ${file} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)})`,
        { hint: `Restrict it with: chmod 600 ${file}` },
      );
    }
    const parsed = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OagMcpError(
        "SECRETS_FILE_INVALID",
        `Secrets file ${file} must be a mapping of key to string value`,
      );
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    this.fileSecrets = out;
    return out;
  }

  /**
   * Resolve a reference to its value.
   *
   * @param {Object} ref - secret reference
   * @param {String} label - what the value is for (for messages, never the value)
   * @return {String} secret value
   */
  resolve(ref: SecretRef, label: string): string {
    if ("env" in ref) {
      const v = (this.opts.env ?? process.env)[ref.env];
      if (v === undefined || v === "") {
        throw new OagMcpError(
          "SECRET_NOT_FOUND",
          `Environment variable ${ref.env} (for ${label}) is not set`,
          {
            hint: `Export ${ref.env} in the environment of the oag-mcp server.`,
          },
        );
      }
      return v;
    }
    const v = this._load()[ref.secret];
    if (v === undefined || v === "") {
      throw new OagMcpError(
        "SECRET_NOT_FOUND",
        `Secret "${ref.secret}" (for ${label}) is not in the secrets file`,
      );
    }
    return v;
  }
}
