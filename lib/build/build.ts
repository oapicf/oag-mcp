"use strict";
/**
 * `oag-mcp build`: prepare an SDK once and write a self-contained artifact.
 *
 * @module build/build
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OagMcpError } from "../errors.js";
import { AgentTypeChecker } from "../executor/typecheck.js";
import { DenoExecutor, resolveDeno } from "../executor/deno-executor.js";
import type { Logs } from "../logging/logger.js";
import { MethodSearchIndex } from "../search/search-index.js";
import type { ArtifactManifest, MethodRecord } from "../types.js";
import { sha256File, sha256Tree } from "../util/hash.js";
import {
  ARTIFACT_FORMAT_VERSION,
  DEFAULT_OAG_VERSION,
  DENO_VERSION_RANGE,
  dependencyVersion,
  oagMcpVersion,
  packageRoot,
} from "../version.js";
import { SdkAnalyzer, scanImplementation } from "./analyze.js";
import {
  ARTIFACT_PATHS,
  MANIFEST_FILE,
  artifactReadme,
  bindingDeclaration,
  hashArtifactFiles,
} from "./artifact.js";
import {
  bundleSdk,
  copyDeclarations,
  copyTsLibs,
  emitDeclarations,
} from "./bundle.js";
import { inspectSdk, validateGeneratorOptions } from "./compat.js";
import { generateSdk } from "./generate.js";
import { buildRecords, hintsForOperation } from "./index-builder.js";
import { stageSdkInput } from "./sdk-input.js";
import { loadSpec } from "./spec.js";

/** Options for {@link build}. */
export interface BuildOptions {
  spec: string;
  sdk?: string;
  generateSdk?: boolean;
  out: string;
  oagVersion?: string;
  oagBackend?: "java" | "docker";
  oagJar?: string;
  oagOptions?: Record<string, string>;
  sdkLayout?: "auto" | "source" | "compiled";
  sdkOagVersion?: string;
  allowUntestedOagVersion?: boolean;
  installDependencies?: boolean;
  verifyWithDeno?: boolean;
  force?: boolean;
  logs: Logs;
}

/** Result of {@link build}. */
export interface BuildResult {
  outDir: string;
  manifest: ArtifactManifest;
  records: MethodRecord[];
  warnings: string[];
}

/**
 * Slugify a title into an npm package name segment.
 *
 * @private
 */
function _slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "api"
  );
}

/**
 * Install SDK runtime dependencies in the working copy when needed.
 *
 * @private
 */
function _ensureDependencies(
  root: string,
  deps: Record<string, string> | undefined,
  install: boolean,
  logs: Logs,
): void {
  const names = Object.keys(deps ?? {});
  const missing = names.filter(
    (n) => !fs.existsSync(path.join(root, "node_modules", n, "package.json")),
  );
  if (missing.length === 0) {
    return;
  }
  if (!install) {
    throw new OagMcpError(
      "SDK_DEPENDENCIES_MISSING",
      `SDK runtime dependencies are not installed: ${missing.join(", ")}`,
      {
        hint: "Run `npm install` in the SDK first, or omit --no-install to let oag-mcp install them (network access may be required).",
      },
    );
  }
  logs.op("info", "build.sdk.dependencies.install_started", {
    count: missing.length,
    note: "npm may need network access unless dependencies are cached locally",
  });
  const res = spawnSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
    ],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
  );
  if (res.status !== 0) {
    throw new OagMcpError(
      "SDK_DEPENDENCIES_INSTALL_FAILED",
      `Installing SDK dependencies failed: ${(res.stderr || res.stdout || "").split("\n").slice(-5).join(" ")}`,
      {
        hint: "Install them in the SDK directory yourself (offline caches work), then rebuild with --no-install.",
      },
    );
  }
  logs.op("info", "build.sdk.dependencies.install_completed", {
    count: missing.length,
  });
}

/**
 * Prepare the output location: refuse to clobber anything that is not a
 * previous artifact.
 *
 * @private
 */
function _prepareOut(out: string, force: boolean): void {
  if (!fs.existsSync(out)) {
    return;
  }
  const entries = fs.readdirSync(out);
  if (entries.length === 0) {
    fs.rmdirSync(out);
    return;
  }
  if (!entries.includes(MANIFEST_FILE)) {
    throw new OagMcpError(
      "OUT_DIR_NOT_EMPTY",
      `Output directory ${out} exists and is not an oag-mcp artifact`,
      { hint: "Choose an empty or new --out directory." },
    );
  }
  if (!force) {
    throw new OagMcpError(
      "OUT_DIR_EXISTS",
      `Output directory ${out} already contains an artifact`,
      { hint: "Pass --force to replace it." },
    );
  }
  fs.rmSync(out, { recursive: true, force: true });
}

/**
 * Build an artifact.
 *
 * @param {Object} opts - build options
 * @return {Promise} build result
 */
export async function build(opts: BuildOptions): Promise<BuildResult> {
  const logs = opts.logs;
  const started = Date.now();
  if (Boolean(opts.sdk) === Boolean(opts.generateSdk)) {
    throw new OagMcpError(
      "BUILD_ARGS_INVALID",
      "Specify exactly one of --sdk <path> or --generate-sdk",
    );
  }
  const out = path.resolve(opts.out);
  const specPath = path.resolve(opts.spec);
  if (!fs.existsSync(specPath)) {
    throw new OagMcpError(
      "SPEC_NOT_FOUND",
      `OpenAPI document ${opts.spec} does not exist`,
    );
  }
  if (opts.sdk && path.resolve(opts.sdk) === out) {
    throw new OagMcpError(
      "BUILD_ARGS_INVALID",
      "--out must differ from --sdk; the supplied SDK is never overwritten",
    );
  }
  const warnings: string[] = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oag-mcp-build-"));
  const tmpOut = path.join(
    path.dirname(out),
    `.${path.basename(out)}.tmp-${crypto.randomUUID().slice(0, 8)}`,
  );
  logs.op("info", "build.started", {
    mode: opts.generateSdk ? "generate-sdk" : "existing-sdk",
  });
  try {
    const spec = await loadSpec(specPath);
    logs.op("info", "build.spec.loaded", {
      openapiVersion: spec.openapiVersion,
      operations: spec.operations.length,
      securitySchemes: Object.keys(spec.securitySchemes).length,
    });

    // 1. SDK input.
    let root: string;
    let sdkKind: "directory" | "archive" | "generated";
    let sdkHash: string;
    let generator: ArtifactManifest["tools"]["openapiGenerator"];
    let options: Record<string, string | boolean> = {};
    let optionsSource: ArtifactManifest["target"]["optionsSource"] = "detected";
    if (opts.generateSdk) {
      const props: Record<string, string> = {
        npmName: `${_slug(spec.title)}-sdk`,
        npmVersion: /^\d+\.\d+\.\d+/.test(spec.apiVersion)
          ? spec.apiVersion
          : "1.0.0",
        ...(opts.oagOptions ?? {}),
      };
      validateGeneratorOptions(props);
      const gen = await generateSdk({
        specPath,
        outDir: path.join(workDir, "generated"),
        version: opts.oagVersion ?? DEFAULT_OAG_VERSION,
        backend: opts.oagBackend ?? "java",
        jarPath: opts.oagJar,
        additionalProperties: props,
        allowUntestedVersion: opts.allowUntestedOagVersion,
        logs,
      });
      root = gen.dir;
      sdkKind = "generated";
      sdkHash = sha256Tree(root);
      generator = { version: gen.version, backend: gen.backend };
      options = props;
      optionsSource = "generator-arguments";
    } else {
      const staged = await stageSdkInput(opts.sdk!, workDir);
      root = staged.root;
      sdkKind = staged.kind;
      sdkHash = staged.sha256;
    }

    // 2. Compatibility.
    const insp = inspectSdk(root, {
      layout: opts.sdkLayout,
      declaredOagVersion: opts.sdkOagVersion,
      allowUntestedOagVersion: opts.allowUntestedOagVersion,
    });
    warnings.push(...insp.warnings);
    if (optionsSource === "detected") {
      options = insp.detectedOptions;
    }
    logs.op("info", "build.compat.checked", {
      layout: insp.layout,
      oagVersion: insp.oagVersion,
      oagVersionTested: insp.oagVersionTested,
      apiFiles: insp.apiFiles.length,
      outcome: "success",
    });
    _ensureDependencies(
      root,
      insp.pkg?.dependencies,
      opts.installDependencies !== false,
      logs,
    );

    // 3. Declarations and analysis.
    fs.mkdirSync(tmpOut, { recursive: true });
    const sdkDir = path.join(tmpOut, "sdk");
    const typesDir = path.join(tmpOut, ARTIFACT_PATHS.types);
    if (insp.layout === "source") {
      const diags = emitDeclarations(insp.entry, typesDir);
      if (diags.length > 0) {
        warnings.push(
          `SDK declarations emitted with ${diags.length} TypeScript diagnostic(s): ${diags[0]}`,
        );
      }
    } else {
      copyDeclarations(insp.typesDir!, typesDir);
    }
    const impl = scanImplementation(insp.apiFiles);
    const analyzer = new SdkAnalyzer(path.join(typesDir, "index.d.ts"));
    const byKey = new Map(spec.operations.map((o) => [o.key, o]));
    const methods = analyzer.analyze(impl, (m, p) =>
      hintsForOperation(byKey.get(`${m} ${p}`)),
    );
    const { records, bindings, unmapped } = buildRecords(spec, methods);
    for (const u of unmapped) {
      warnings.push(
        `Operation ${u.key}${u.operationId ? ` (${u.operationId})` : ""} has no SDK method and is not available`,
      );
    }
    logs.op("info", "build.index.created", {
      methods: records.length,
      unmappedOperations: unmapped.length,
    });

    // 4. Execution bundle and runtime files.
    const bundle = await bundleSdk({
      entry: insp.entry,
      root,
      outFile: path.join(tmpOut, ARTIFACT_PATHS.bundle),
      classNames: [...new Set(records.map((r) => r.className))],
    });
    logs.op("info", "build.sdk.bundled", {
      bytes: bundle.bytes,
      exports: bundle.exports.length,
    });
    copyTsLibs(path.join(tmpOut, ARTIFACT_PATHS.tsLib));
    fs.mkdirSync(path.join(tmpOut, "executor"), { recursive: true });
    fs.copyFileSync(
      path.join(packageRoot(), "assets", "deno-runner.js"),
      path.join(tmpOut, ARTIFACT_PATHS.runner),
    );
    fs.writeFileSync(
      path.join(tmpOut, ARTIFACT_PATHS.binding),
      bindingDeclaration(records),
    );
    fs.mkdirSync(path.join(tmpOut, "index"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpOut, ARTIFACT_PATHS.methods),
      JSON.stringify(records, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpOut, ARTIFACT_PATHS.searchIndex),
      new MethodSearchIndex(records).serialise(),
    );

    // 5. Self-checks: every generated example type-checks, and the bundle
    // loads in the Deno sandbox with every binding present.
    const checker = new AgentTypeChecker(
      sdkDir,
      path.join(tmpOut, ARTIFACT_PATHS.tsLib),
    );
    for (const r of records) {
      const diags = checker.check(r.example);
      if (diags.length > 0) {
        warnings.push(
          `Example for ${r.id} does not type-check: ${diags[0].message}`,
        );
      }
    }
    if (opts.verifyWithDeno !== false) {
      const deno = resolveDeno();
      await new DenoExecutor({ artifactDir: tmpOut, deno, logs }).verify(
        bindings,
        "http://localhost",
      );
      logs.op("info", "build.executor.verified", {
        denoVersion: deno.version,
        outcome: "success",
      });
    }

    // 6. Independent SDK package for the generate path.
    if (sdkKind === "generated") {
      fs.cpSync(root, path.join(tmpOut, ARTIFACT_PATHS.sdkPackage), {
        recursive: true,
      });
    }

    // 7. Manifest, package.json, README.
    const buildId = crypto.randomUUID();
    const manifest: ArtifactManifest = {
      format: "oag-mcp-artifact",
      formatVersion: ARTIFACT_FORMAT_VERSION,
      buildId,
      createdAt: new Date().toISOString(),
      oagMcpVersion: oagMcpVersion(),
      target: {
        generator: "typescript-fetch",
        oagVersion: insp.oagVersion,
        oagVersionTested: insp.oagVersionTested,
        options,
        optionsSource,
        sdkLayout: insp.layout,
        sdkPackage: insp.pkg
          ? { name: insp.pkg.name, version: insp.pkg.version }
          : undefined,
      },
      tools: {
        typescript: dependencyVersion("typescript"),
        esbuild: dependencyVersion("esbuild"),
        deno: {
          minVersion: DENO_VERSION_RANGE.min,
          maxVersionExclusive: DENO_VERSION_RANGE.maxExclusive,
        },
        openapiGenerator: generator,
      },
      inputs: {
        spec: {
          fileName: path.basename(specPath),
          sha256: sha256File(specPath),
        },
        sdk: { kind: sdkKind, sha256: sdkHash },
      },
      api: {
        title: spec.title,
        version: spec.apiVersion,
        description: spec.description,
        servers: spec.servers,
        tags: spec.tags,
      },
      securitySchemes: spec.securitySchemes,
      operations: bindings,
      unmappedOperations: unmapped,
      files: {},
    };
    fs.writeFileSync(path.join(tmpOut, "README.md"), artifactReadme(manifest));
    fs.writeFileSync(
      path.join(tmpOut, "package.json"),
      `${JSON.stringify(
        {
          name: `${_slug(spec.title)}-mcp-server`,
          version: /^\d+\.\d+\.\d+/.test(spec.apiVersion)
            ? spec.apiVersion
            : "1.0.0",
          private: true,
          description: `oag-mcp code-mode MCP server for ${spec.title}`,
          type: "module",
          scripts: {
            "start:stdio": "oag-mcp serve . --transport stdio",
            "start:http": "oag-mcp serve . --transport streamable-http",
          },
          dependencies: { "oag-mcp": oagMcpVersion() },
          engines: { node: ">= 22.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    manifest.files = hashArtifactFiles(tmpOut);
    fs.writeFileSync(
      path.join(tmpOut, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    _prepareOut(out, Boolean(opts.force));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.renameSync(tmpOut, out);
    logs.op("info", "build.artifact.written", {
      buildId,
      methods: records.length,
      files: Object.keys(manifest.files).length,
      durationMs: Date.now() - started,
      outcome: "success",
    });
    return { outDir: out, manifest, records, warnings };
  } catch (err) {
    fs.rmSync(tmpOut, { recursive: true, force: true });
    logs.op("error", "build.failed", {
      errorCode: err instanceof OagMcpError ? err.code : "UNEXPECTED",
      durationMs: Date.now() - started,
      outcome: "failure",
    });
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
