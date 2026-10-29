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

/**
 * An HTTP authentication scheme followed by a value, as in an Authorization
 * header. Scheme names are case-insensitive in HTTP, so the match is too;
 * {@link _credentialLike} then decides whether the value is a credential or
 * just the next word of a sentence.
 */
const AUTH_SCHEME_VALUE =
  /\b(Bearer|Basic|Digest)\s+([A-Za-z0-9._~+/=-]{4,})/gi;

/** Patterns that look like credentials inside free text. */
const TEXT_PATTERNS: Array<[RegExp, string]> = [
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
    out = out.replace(
      AUTH_SCHEME_VALUE,
      (match, scheme: string, value: string) =>
        _credentialLike(value) ? `${scheme} ${REDACTED}` : match,
    );
    for (const [re, replacement] of TEXT_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  }
}

/**
 * Whether the value after an authentication scheme looks like a credential
 * rather than a word of prose ("bearer does not…", "Basic authentication"):
 * it has a digit or token punctuation, mixes cases the way base64 does, or is
 * long. Registered secrets are scrubbed whatever they look like.
 *
 * @param {String} value - the value after the scheme name
 * @return {Boolean} true when it should be redacted
 * @private
 */
function _credentialLike(value: string): boolean {
  return (
    value.length >= 20 ||
    /[0-9._~+/=-]/.test(value) ||
    (/[a-z]/.test(value) && /[A-Z]/.test(value.slice(1)))
  );
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

/** Limits and state of one {@link boundValue} walk. */
interface Walk {
  maxString: number;
  maxDepth: number;
  maxKeys: number;
  maxArray: number;
  registry: SecretRegistry;
  seen: WeakSet<object>;
}

/** Marks a value that is not a scalar, so it is walked as an object. */
const NOT_SCALAR = Symbol("not scalar");

/**
 * Produce a bounded, scrubbed, JSON-safe copy of a value for logging.
 * Sensitive keys are censored, long strings truncated, deep structures cut.
 *
 * @param {*} value - value to bound
 * @param {Object} [opts] - limits
 * @return {*} bounded copy
 */
export function boundValue(value: unknown, opts: BoundOptions = {}): unknown {
  return _walk(value, 0, {
    maxString: opts.maxString ?? 512,
    maxDepth: opts.maxDepth ?? 6,
    maxKeys: opts.maxKeys ?? 50,
    maxArray: opts.maxArray ?? 50,
    registry: opts.registry ?? secrets,
    seen: new WeakSet<object>(),
  });
}

/**
 * Bound one value at a depth.
 *
 * @private
 */
function _walk(v: unknown, depth: number, w: Walk): unknown {
  const scalar = _scalar(v, w);
  if (scalar !== NOT_SCALAR) {
    return scalar;
  }
  const obj = v as object;
  if (w.seen.has(obj)) {
    return "[circular]";
  }
  if (depth >= w.maxDepth) {
    return "[max-depth]";
  }
  w.seen.add(obj);
  return Array.isArray(obj)
    ? _walkArray(obj, depth, w)
    : _walkObject(obj as Record<string, unknown>, depth, w);
}

/**
 * Bound a value that is not walked into: strings (scrubbed and truncated),
 * other primitives, errors and dates.
 *
 * @private
 */
function _scalar(v: unknown, w: Walk): unknown {
  if (v === null || v === undefined) {
    return v;
  }
  switch (typeof v) {
    case "string": {
      const s = w.registry.scrub(v);
      return s.length > w.maxString
        ? `${s.slice(0, w.maxString)}…[truncated ${s.length - w.maxString}]`
        : s;
    }
    case "number":
    case "boolean":
      return v;
    case "bigint":
      return v.toString();
    case "object":
      return _scalarObject(v, w);
    default:
      return `[${typeof v}]`;
  }
}

/**
 * Bound errors (sanitised) and dates (ISO 8601); other objects are walked.
 *
 * @private
 */
function _scalarObject(v: object, w: Walk): unknown {
  if (v instanceof Error) {
    return sanitizeError(v, w.registry);
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  return NOT_SCALAR;
}

/**
 * Bound an array: its first items, then a count of the rest.
 *
 * @private
 */
function _walkArray(v: unknown[], depth: number, w: Walk): unknown[] {
  const arr = v.slice(0, w.maxArray).map((x) => _walk(x, depth + 1, w));
  if (v.length > w.maxArray) {
    arr.push(`[+${v.length - w.maxArray} more]`);
  }
  return arr;
}

/**
 * Bound an object: its first keys, with sensitive keys censored.
 *
 * @private
 */
function _walkObject(
  v: Record<string, unknown>,
  depth: number,
  w: Walk,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, val] of Object.entries(v)) {
    if (count++ >= w.maxKeys) {
      out["…"] = "[more keys truncated]";
      break;
    }
    out[k] = isSensitiveKey(k) ? REDACTED : _walk(val, depth + 1, w);
  }
  return out;
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
