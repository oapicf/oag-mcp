"use strict";
/**
 * Redaction and sanitisation of values before they reach logs, errors,
 * search results or tool output.
 *
 * @module util/redact
 */

/** Placeholder written in place of a sensitive value. */
export const REDACTED = "[REDACTED]";

/** Key names whose values are always censored, matched case-insensitively. */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_?secret|api_?key|apikey|x-api-key|token|access_?token|refresh_?token|id_?token|bearer|credentials?|private_?key)$/i;

/** Patterns that look like credentials inside free text. */
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{4,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [
    /([?&;](?:api[_-]?key|apikey|access_token|token|key|secret|password|client_secret|code|sig|signature)=)[^&#\s"']+/gi,
    `$1${REDACTED}`,
  ],
  [/(\/\/)[^/@\s:]+:[^/@\s]+@/g, `$1${REDACTED}@`],
];

/**
 * Registry of secret values known to the process (upstream credentials,
 * issued upstream tokens, MCP bearer tokens). Every outbound string is
 * scrubbed against it.
 */
export class SecretRegistry {
  private readonly values = new Set<string>();

  /**
   * Register a secret value. Values shorter than 4 characters are ignored
   * because scrubbing them would corrupt ordinary text.
   *
   * @param {String} value - secret value
   */
  add(value: string | undefined | null): void {
    if (typeof value === "string" && value.length >= 4) {
      this.values.add(value);
      // Also catch the base64 forms used by HTTP Basic credentials.
      this.values.add(Buffer.from(value).toString("base64"));
    }
  }

  /**
   * Forget a secret value (e.g. an expired token).
   *
   * @param {String} value - secret value
   */
  remove(value: string | undefined): void {
    if (value) {
      this.values.delete(value);
      this.values.delete(Buffer.from(value).toString("base64"));
    }
  }

  /**
   * Number of registered values.
   *
   * @return {Number} count
   */
  get size(): number {
    return this.values.size;
  }

  /**
   * Replace only registered secret values (no heuristics), for data such as
   * API results where pattern-based scrubbing could corrupt content.
   *
   * @param {String} text - text to scrub
   * @return {String} scrubbed text
   */
  scrubKnown(text: string): string {
    let out = text;
    const sorted = [...this.values].sort((a, b) => b.length - a.length);
    for (const v of sorted) {
      if (out.includes(v)) {
        out = out.split(v).join(REDACTED);
      }
    }
    return out;
  }

  /**
   * Replace registered secret values and credential-looking patterns.
   *
   * @param {String} text - text to scrub
   * @return {String} scrubbed text
   */
  scrub(text: string): string {
    let out = text;
    // Longest first so a secret containing another secret is fully hidden.
    const sorted = [...this.values].sort((a, b) => b.length - a.length);
    for (const v of sorted) {
      if (out.includes(v)) {
        out = out.split(v).join(REDACTED);
      }
    }
    for (const [re, replacement] of TEXT_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  }
}

/** Process-wide registry used by the logger and error sanitisers. */
export const secrets = new SecretRegistry();

/**
 * Whether a key name denotes a sensitive value.
 *
 * @param {String} key - property name
 * @return {Boolean} true when sensitive
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Limits applied by {@link boundValue}. */
export interface BoundOptions {
  maxString?: number;
  maxDepth?: number;
  maxKeys?: number;
  maxArray?: number;
  registry?: SecretRegistry;
}

/**
 * Produce a bounded, scrubbed, JSON-safe copy of a value for logging.
 * Sensitive keys are censored, long strings truncated, deep structures cut.
 *
 * @param {*} value - value to bound
 * @param {Object} [opts] - limits
 * @return {*} bounded copy
 */
export function boundValue(value: unknown, opts: BoundOptions = {}): unknown {
  const maxString = opts.maxString ?? 512;
  const maxDepth = opts.maxDepth ?? 6;
  const maxKeys = opts.maxKeys ?? 50;
  const maxArray = opts.maxArray ?? 50;
  const registry = opts.registry ?? secrets;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) {
      return v;
    }
    if (typeof v === "string") {
      const s = registry.scrub(v);
      return s.length > maxString
        ? `${s.slice(0, maxString)}…[truncated ${s.length - maxString}]`
        : s;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      return v;
    }
    if (typeof v === "bigint") {
      return v.toString();
    }
    if (typeof v !== "object") {
      return `[${typeof v}]`;
    }
    if (v instanceof Error) {
      return sanitizeError(v, registry);
    }
    if (v instanceof Date) {
      return v.toISOString();
    }
    if (seen.has(v as object)) {
      return "[circular]";
    }
    if (depth >= maxDepth) {
      return "[max-depth]";
    }
    seen.add(v as object);
    if (Array.isArray(v)) {
      const arr = v.slice(0, maxArray).map((x) => walk(x, depth + 1));
      if (v.length > maxArray) {
        arr.push(`[+${v.length - maxArray} more]`);
      }
      return arr;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (count++ >= maxKeys) {
        out["…"] = "[more keys truncated]";
        break;
      }
      out[k] = isSensitiveKey(k) ? REDACTED : walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * Sanitise an error into a small structured object without stack traces.
 *
 * @param {Error} err - error to sanitise
 * @param {SecretRegistry} [registry] - registry used to scrub messages
 * @return {Object} { name, code, message }
 */
export function sanitizeError(
  err: unknown,
  registry: SecretRegistry = secrets,
): { name: string; code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const message = registry.scrub(err.message || "");
    return {
      name: err.name,
      ...(typeof code === "string" ? { code } : {}),
      message: message.length > 1000 ? `${message.slice(0, 1000)}…` : message,
    };
  }
  return { name: "Error", message: registry.scrub(String(err)).slice(0, 1000) };
}
