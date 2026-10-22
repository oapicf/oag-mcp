"use strict";
/**
 * Type-check agent TypeScript against the exposed `sdk` binding.
 *
 * Type checking is a correctness aid that returns useful diagnostics before
 * code runs; it is not an authorisation boundary.
 *
 * @module executor/typecheck
 */
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { sdkCompilerOptions } from "../prepare/bundle.js";
import { mapDiagnostic, wrapForTypecheck } from "./code-policy.js";
import type { Diagnostic } from "./types.js";

/**
 * A persistent language service over the prepared SDK declarations.
 */
export class AgentTypeChecker {
  private readonly service: ts.LanguageService;
  private readonly agentFile: string;
  private readonly libDir: string;
  private version = 0;
  private current = "";
  private readonly options: ts.CompilerOptions;

  /**
   * @param {String} sdkDir - workspace sdk/ directory (contains types/ and sdk-binding.d.ts)
   * @param {String} libDir - directory with TypeScript lib files
   */
  constructor(sdkDir: string, libDir: string) {
    this.libDir = libDir;
    this.agentFile = path.join(sdkDir, "__agent__.ts");
    const bindingFile = path.join(sdkDir, "sdk-binding.d.ts");
    this.options = {
      ...sdkCompilerOptions(),
      noEmit: true,
      strict: true,
      noImplicitAny: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
      noImplicitReturns: false,
      allowUnreachableCode: true,
    };
    const snapshots = new Map<string, ts.IScriptSnapshot>();
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [bindingFile, this.agentFile],
      getScriptVersion: (f) =>
        f === this.agentFile ? String(this.version) : "0",
      getScriptSnapshot: (f) => {
        if (f === this.agentFile) {
          return ts.ScriptSnapshot.fromString(this.current);
        }
        let snap = snapshots.get(f);
        if (!snap) {
          if (!fs.existsSync(f)) {
            return undefined;
          }
          snap = ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8"));
          snapshots.set(f, snap);
        }
        return snap;
      },
      getCurrentDirectory: () => sdkDir,
      getDefaultLibFileName: () => path.join(this.libDir, "lib.es2022.d.ts"),
      fileExists: (f) => f === this.agentFile || fs.existsSync(f),
      readFile: (f) =>
        f === this.agentFile
          ? this.current
          : fs.existsSync(f)
            ? fs.readFileSync(f, "utf8")
            : undefined,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /**
   * Type-check agent code.
   *
   * @param {String} code - agent TypeScript (function body)
   * @return {Array} diagnostics (empty when the code type-checks)
   */
  check(code: string): Diagnostic[] {
    this.current = wrapForTypecheck(code);
    this.version++;
    const diags = [
      ...this.service.getSyntacticDiagnostics(this.agentFile),
      ...this.service.getSemanticDiagnostics(this.agentFile),
    ].filter((d) => d.category === ts.DiagnosticCategory.Error);
    return diags
      .map(mapDiagnostic)
      .filter((d): d is Diagnostic => Boolean(d))
      .slice(0, 10);
  }

  /** Warm the language service so the first agent call is fast. */
  warmUp(): void {
    this.check("return 1;");
  }
}
