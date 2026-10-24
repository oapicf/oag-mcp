"use strict";
/**
 * Resolution of secret references (`{ env: NAME }` or `{ secret: key }`)
 * used in the configuration file. Values are read at start-up from the
 * environment or from a protected local secrets file, never from the
 * configuration file itself.
 *
 * @module util/secrets
 */
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { SecretRef } from "../config.js";
import { OagMcpError } from "../errors.js";

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
