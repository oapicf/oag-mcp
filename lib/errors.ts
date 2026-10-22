"use strict";
/**
 * Error types shared across oag-mcp components.
 *
 * @module errors
 */

/**
 * An error carrying a stable machine-readable code and an actionable hint
 * for the person running the CLI.
 */
export class OagMcpError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  /**
   * @param {String} code - stable error code, e.g. "SDK_LAYOUT_UNSUPPORTED"
   * @param {String} message - human-readable description
   * @param {Object} [opts] - optional settings
   * @param {String} [opts.hint] - actionable next step
   * @param {Object} [opts.details] - structured, non-sensitive context
   * @param {Error} [opts.cause] - underlying error
   */
  constructor(
    code: string,
    message: string,
    opts: {
      hint?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "OagMcpError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

/**
 * Format an error for terminal output (stderr), including its hint.
 *
 * @param {Error} err - error to format
 * @return {String} formatted message
 */
export function formatCliError(err: unknown): string {
  if (err instanceof OagMcpError) {
    const lines = [`Error [${err.code}]: ${err.message}`];
    if (err.hint) {
      lines.push(`Hint: ${err.hint}`);
    }
    return lines.join("\n");
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Error: ${String(err)}`;
}
