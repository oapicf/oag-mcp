"use strict";
/**
 * Prepare the SDK once at build time: bundle it into a single ES module for
 * the Deno executor, and produce TypeScript declarations used to type-check
 * agent code.
 *
 * @module build/bundle
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import * as esbuild from "esbuild";
import ts from "typescript";

import { OagMcpError } from "../errors.js";
import { listFiles } from "../util/hash.js";

const require = createRequire(import.meta.url);

/** Exports the runner requires from every SDK bundle. */
export const REQUIRED_RUNTIME_EXPORTS = ["Configuration", "BaseAPI"];

/** TypeScript libs made available to agent code. */
export const AGENT_TS_LIBS = [
  "lib.es2022.d.ts",
  "lib.dom.d.ts",
  "lib.dom.iterable.d.ts",
  "lib.dom.asynciterable.d.ts",
];

/** Compiler options used for SDK declarations and agent type checks. */
export function sdkCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: AGENT_TS_LIBS,
    types: [],
    strict: false,
    skipLibCheck: true,
    allowJs: false,
    noEmitOnError: false,
    esModuleInterop: true,
  };
}

/**
 * Whether a JavaScript entry is CommonJS.
 *
 * @private
 */
function _isCommonJs(entry: string): boolean {
  if (entry.endsWith(".ts")) {
    return false;
  }
  const text = fs.readFileSync(entry, "utf8");
  return !/^\s*export\s/m.test(text) && /\b(exports\.|require\()/.test(text);
}

/**
 * Bundle the SDK into a single ESM file with all runtime dependencies.
 *
 * @param {Object} opts - options
 * @param {String} opts.entry - SDK entry module
 * @param {String} opts.root - SDK working copy root (for resolution)
 * @param {String} opts.outFile - bundle output path
 * @param {Array} opts.classNames - API classes that must be exported
 * @return {Promise} { exports, bytes }
 */
export async function bundleSdk(opts: {
  entry: string;
  root: string;
  outFile: string;
  classNames: string[];
}): Promise<{ exports: string[]; bytes: number }> {
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  let entry = opts.entry;
  if (_isCommonJs(entry)) {
    // CommonJS entries lose named exports when bundled to ESM; re-export the
    // names the runner needs from a generated ESM shim.
    const shim = path.join(opts.root, "__oag_mcp_entry.mjs");
    const names = [
      ...new Set([
        ...REQUIRED_RUNTIME_EXPORTS,
        "ResponseError",
        "FetchError",
        "RequiredError",
        ...opts.classNames,
      ]),
    ];
    fs.writeFileSync(
      shim,
      `import __sdk from ${JSON.stringify("./" + path.relative(opts.root, entry).split(path.sep).join("/"))};\n` +
        names.map((n) => `export const ${n} = __sdk.${n};`).join("\n") +
        "\n",
    );
    entry = shim;
  }
  let result: esbuild.BuildResult<{ metafile: true }>;
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      absWorkingDir: opts.root,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      mainFields: ["module", "main"],
      conditions: ["import", "default"],
      outfile: opts.outFile,
      metafile: true,
      write: true,
      logLevel: "silent",
      legalComments: "inline",
      banner: {
        js: "// oag-mcp SDK execution bundle. Generated from the user's OpenAPI Generator typescript-fetch SDK; do not edit.",
      },
    });
  } catch (err) {
    const errors = (err as esbuild.BuildFailure).errors ?? [];
    throw new OagMcpError(
      "SDK_BUNDLE_FAILED",
      `Bundling the SDK failed: ${errors
        .slice(0, 5)
        .map((e) => e.text)
        .join("; ")}`,
      {
        hint: "If the SDK has runtime dependencies, make sure they are installed in the SDK (node_modules) or let oag-mcp install them. Node.js built-in modules cannot be used by the sandboxed SDK.",
        cause: err,
      },
    );
  }
  const out = Object.values(result.metafile.outputs)[0];
  const exports = out?.exports ?? [];
  const missing = [...REQUIRED_RUNTIME_EXPORTS, ...opts.classNames].filter(
    (n) => !exports.includes(n),
  );
  if (missing.length > 0) {
    throw new OagMcpError(
      "SDK_BUNDLE_EXPORTS",
      `The SDK bundle does not export: ${missing.join(", ")}`,
      {
        hint: "The SDK index module must re-export runtime and apis (typescript-fetch does this by default). Check for a modified index.ts.",
      },
    );
  }
  return { exports, bytes: fs.statSync(opts.outFile).size };
}

/**
 * Emit TypeScript declarations for an SDK in source layout.
 *
 * @param {String} entry - SDK index.ts
 * @param {String} outDir - declarations output directory
 * @return {Array} non-fatal diagnostics
 */
export function emitDeclarations(entry: string, outDir: string): string[] {
  const options: ts.CompilerOptions = {
    ...sdkCompilerOptions(),
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: path.dirname(entry),
    outDir,
  };
  const program = ts.createProgram([entry], options);
  const emit = program.emit();
  const diags = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics];
  const messages = diags
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  if (emit.emitSkipped || !fs.existsSync(path.join(outDir, "index.d.ts"))) {
    throw new OagMcpError(
      "SDK_DECLARATIONS_FAILED",
      `Emitting SDK declarations failed: ${messages.slice(0, 5).join("; ")}`,
    );
  }
  return messages;
}

/**
 * Copy compiled declarations into the artifact.
 *
 * @param {String} typesDir - SDK declarations directory (e.g. dist)
 * @param {String} outDir - artifact types directory
 */
export function copyDeclarations(typesDir: string, outDir: string): void {
  for (const rel of listFiles(typesDir, (r) => !r.startsWith("esm/"))) {
    if (rel.endsWith(".d.ts")) {
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(typesDir, rel), dest);
    }
  }
}

/**
 * Copy the transitive closure of TypeScript lib files needed for agent
 * type checks, so type checking works without the TypeScript package's lib
 * directory at runtime.
 *
 * @param {String} outDir - destination directory
 * @return {Array} copied file names
 */
export function copyTsLibs(outDir: string): string[] {
  const libDir = path.dirname(require.resolve("typescript/lib/lib.d.ts"));
  const seen = new Set<string>();
  const queue = [...AGENT_TS_LIBS];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const text = fs.readFileSync(path.join(libDir, name), "utf8");
    for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"/g)) {
      queue.push(`lib.${m[1].toLowerCase()}.d.ts`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of seen) {
    fs.copyFileSync(path.join(libDir, name), path.join(outDir, name));
  }
  return [...seen].sort();
}
