"use strict";
/**
 * Static checks and transpilation of agent-submitted code.
 *
 * Agent code is the body of an async function receiving `sdk` and
 * `console`. Module syntax and dynamic `import()` are rejected before
 * execution; the Deno sandbox additionally disables string code generation
 * so imports cannot be smuggled through eval. These checks are defence in
 * depth, not the security boundary: the separate, permissionless Deno
 * process is.
 *
 * @module executor/code-policy
 */
import ts from "typescript";

import type { Diagnostic, ExecutionError } from "./types.js";

/** Number of wrapper lines that precede agent code. */
export const WRAPPER_HEADER_LINES = 1;

/** Result of preparing code. */
export type PreparedCode =
  | { ok: true; moduleBase64: string; js: string }
  | { ok: false; error: ExecutionError; violations?: string[] };

/**
 * Wrap agent code for transpilation and execution.
 *
 * @param {String} code - agent code
 * @return {String} module source
 */
export function wrapForExecution(code: string): string {
  return `export default async function __oagMcpMain(sdk, console) {\n${code}\n}\n`;
}

/**
 * Wrap agent code for type checking against the global `sdk` declaration.
 *
 * @param {String} code - agent code
 * @return {String} TypeScript source
 */
export function wrapForTypecheck(code: string): string {
  return `export {}; async function __oagMcpMain() {\n${code}\n}\n`;
}

/**
 * Convert a TypeScript diagnostic to agent coordinates.
 *
 * @param {Object} d - diagnostic
 * @return {Object|undefined} mapped diagnostic
 */
export function mapDiagnostic(d: ts.Diagnostic): Diagnostic | undefined {
  if (!d.file || d.start === undefined) {
    return {
      line: 0,
      column: 0,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  }
  const pos = d.file.getLineAndCharacterOfPosition(d.start);
  const line = pos.line + 1 - WRAPPER_HEADER_LINES;
  return {
    line: Math.max(line, 1),
    column: pos.character + 1,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  };
}

/**
 * Find module-loading constructs in agent code.
 *
 * @param {String} code - agent code
 * @param {String} language - "typescript" or "javascript"
 * @return {Array} violation descriptions with line numbers
 */
export function findViolations(
  code: string,
  language: "typescript" | "javascript",
): string[] {
  const sf = ts.createSourceFile(
    language === "typescript" ? "agent.ts" : "agent.js",
    wrapForExecution(code),
    ts.ScriptTarget.ES2022,
    true,
    language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const out: string[] = [];
  const where = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line +
    1 -
    WRAPPER_HEADER_LINES;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      out.push(`dynamic import() at line ${where(n)}`);
    } else if (
      ts.isMetaProperty(n) &&
      n.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      out.push(`import.meta at line ${where(n)}`);
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "require"
    ) {
      out.push(`require() at line ${where(n)}`);
    } else if (
      ts.isImportDeclaration(n) ||
      ts.isImportEqualsDeclaration(n) ||
      (ts.isExportDeclaration(n) && n.moduleSpecifier)
    ) {
      out.push(`module import at line ${where(n)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Validate and transpile agent code into a base64 ES module.
 *
 * @param {String} code - agent code
 * @param {String} language - "typescript" or "javascript"
 * @param {Number} maxBytes - maximum accepted code size
 * @return {Object} prepared code or error
 */
export function prepareCode(
  code: string,
  language: "typescript" | "javascript",
  maxBytes: number,
): PreparedCode {
  if (Buffer.byteLength(code) > maxBytes) {
    return {
      ok: false,
      error: {
        type: "resource_limit",
        reason: "code_too_large",
        message: `Code is ${Buffer.byteLength(code)} bytes; the limit is ${maxBytes}`,
      },
    };
  }
  const result = ts.transpileModule(wrapForExecution(code), {
    fileName: language === "typescript" ? "agent.ts" : "agent.js",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      sourceMap: false,
      removeComments: false,
    },
  });
  const syntax = (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map(mapDiagnostic)
    .filter((d): d is Diagnostic => Boolean(d));
  if (syntax.length > 0) {
    return {
      ok: false,
      error: {
        type: "syntax_error",
        message: `Code has ${syntax.length} syntax error(s): ${syntax[0].message} (line ${syntax[0].line})`,
        diagnostics: syntax.slice(0, 10),
      },
    };
  }
  const violations = findViolations(code, language);
  if (violations.length > 0) {
    return {
      ok: false,
      violations,
      error: {
        type: "permission_denied",
        reason: "import_not_allowed",
        message: `Imports are not allowed; use the provided \`sdk\` binding instead (${violations.slice(0, 3).join("; ")})`,
      },
    };
  }
  return {
    ok: true,
    js: result.outputText,
    moduleBase64: Buffer.from(result.outputText).toString("base64"),
  };
}
