"use strict";
/**
 * Start-up preparation: turn an OpenAPI document and an existing
 * typescript-fetch SDK into everything the server needs, once per process.
 *
 * Stages (each logged as `prepare.stage.completed`):
 *
 * 1. `inputs`: validate and load the OpenAPI document; resolve the SDK
 *    directory in place or extract an archive into the workspace.
 * 2. `compatibility`: check generator target, version, options and layout,
 *    and that runtime dependencies are already installed (never installs).
 * 3. `sdk`: declarations (emitted for source SDKs, copied for compiled ones)
 *    and one ES-module execution bundle, written to the workspace.
 * 4. `index`: SDK methods (from declarations and implementation) mapped to
 *    OpenAPI operations, the in-memory search index and the `sdk` binding
 *    declaration.
 *
 * The bridge and executor (stage 5) are assembled by the runtime service.
 * Nothing is written to the supplied SDK; no package manager, lifecycle
 * script or SDK build script is run.
 *
 * @module prepare/prepare
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { OagMcpError } from "../errors.js";
import type { Logs } from "../logging/logger.js";
import { MethodSearchIndex } from "../search/search-index.js";
import type {
  MethodRecord,
  OperationBinding,
  PreparedSdkInfo,
  SpecSummary,
} from "../types.js";
import { sha256File } from "../util/hash.js";
import {
  dependencyVersion,
  oagMcpVersion,
  packageRoot,
} from "../util/version.js";
import { SdkAnalyzer, scanImplementation } from "./analyze.js";
import {
  bundleSdk,
  copyDeclarations,
  copyTsLibs,
  emitDeclarations,
} from "./bundle.js";
import { type SdkInspection, inspectSdk } from "./compat.js";
import { buildRecords, hintsForOperation } from "./index-builder.js";
import {
  type StagedSdk,
  missingDependencies,
  stageSdkInput,
} from "./sdk-input.js";
import { loadSpec } from "./spec.js";
import {
  WORKSPACE_PATHS,
  type Workspace,
  bindingDeclaration,
  createWorkspace,
} from "./workspace.js";

/** Start-up preparation stages, in order. */
export const PREPARE_STAGES = [
  "inputs",
  "compatibility",
  "sdk",
  "index",
  "executor",
] as const;

/** A preparation stage name. */
export type PrepareStage = (typeof PREPARE_STAGES)[number];

/** Options for {@link prepareSdk}. */
export interface PrepareOptions {
  /** OpenAPI 3.0/3.1 document. */
  spec: string;
  /** typescript-fetch SDK directory or npm package archive (.tgz). */
  sdk: string;
  sdkLayout?: "auto" | "source" | "compiled";
  /** Generator version for SDKs lacking .openapi-generator/VERSION. */
  sdkOagVersion?: string;
  allowUntestedOagVersion?: boolean;
  /** Parent of the private workspace, default: OS temporary directory. */
  workspaceRoot?: string;
  /** Cancels preparation between stages (e.g. on SIGTERM during start-up). */
  signal?: AbortSignal;
  logs: Logs;
}

/** A prepared SDK held by one server process. */
export interface PreparedSdk {
  info: PreparedSdkInfo;
  /** Private workspace with sdk/ and executor/ (removed by cleanup). */
  workspaceDir: string;
  records: MethodRecord[];
  bindings: OperationBinding[];
  index: MethodSearchIndex;
  warnings: string[];
  /** Remove the workspace. Never throws; returns whether it succeeded. */
  cleanup(): boolean;
}

/**
 * Run one preparation stage with logging.
 *
 * @param {Object} logs - logs
 * @param {String} stage - stage name
 * @param {Function} fn - stage body
 * @return {Promise} stage result
 */
export async function runStage<T>(
  logs: Logs,
  stage: PrepareStage,
  fn: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    logs.op("info", "prepare.aborted", { stage });
    throw new OagMcpError(
      "STARTUP_ABORTED",
      `Start-up was cancelled before the ${stage} stage`,
      { hint: "The server received a shutdown signal while preparing." },
    );
  }
  const started = Date.now();
  logs.op("debug", "prepare.stage.started", { stage });
  try {
    const out = await fn();
    logs.op("info", "prepare.stage.completed", {
      stage,
      durationMs: Date.now() - started,
      outcome: "success",
    });
    return out;
  } catch (err) {
    const code = err instanceof OagMcpError ? err.code : "UNEXPECTED";
    if (stage === "compatibility") {
      logs.op("error", "prepare.compat.failed", {
        errorCode: code,
        outcome: "failure",
      });
    }
    logs.op("error", "prepare.stage.failed", {
      stage,
      errorCode: code,
      durationMs: Date.now() - started,
      outcome: "failure",
    });
    throw err;
  }
}

/**
 * Stage 1: inputs.
 *
 * @private
 */
async function _inputs(
  opts: PrepareOptions,
  ws: Workspace,
): Promise<{ specPath: string; spec: SpecSummary; staged: StagedSdk }> {
  if (!opts.spec) {
    throw new OagMcpError("CLI_ARGS_INVALID", "--spec is required", {
      hint: "Usage: oag-mcp serve --spec ./openapi.yaml --sdk ./generated-sdk",
    });
  }
  if (!opts.sdk) {
    throw new OagMcpError("CLI_ARGS_INVALID", "--sdk is required", {
      hint: "Pass an existing OpenAPI Generator typescript-fetch SDK directory or .tgz package. oag-mcp does not generate SDKs.",
    });
  }
  const specPath = path.resolve(opts.spec);
  if (!fs.existsSync(specPath) || !fs.statSync(specPath).isFile()) {
    throw new OagMcpError(
      "SPEC_NOT_FOUND",
      `OpenAPI document ${opts.spec} does not exist`,
      { hint: "Pass --spec <file> with an OpenAPI 3.0/3.1 YAML or JSON file." },
    );
  }
  const spec = await loadSpec(specPath);
  opts.logs.op("info", "prepare.spec.loaded", {
    openapiVersion: spec.openapiVersion,
    operations: spec.operations.length,
    securitySchemes: Object.keys(spec.securitySchemes).length,
  });
  const staged = await stageSdkInput(
    opts.sdk,
    path.join(ws.dir, WORKSPACE_PATHS.input),
  );
  opts.logs.op("info", "prepare.sdk.resolved", { sdkKind: staged.kind });
  return { specPath, spec, staged };
}

/**
 * Stage 2: compatibility.
 *
 * @private
 */
function _compatibility(
  opts: PrepareOptions,
  staged: StagedSdk,
): SdkInspection {
  const insp = inspectSdk(staged.root, {
    layout: opts.sdkLayout,
    declaredOagVersion: opts.sdkOagVersion,
    allowUntestedOagVersion: opts.allowUntestedOagVersion,
  });
  const missing = missingDependencies(staged.root, insp.pkg?.dependencies);
  if (missing.length > 0) {
    const how =
      staged.kind === "archive"
        ? "Extract the archive (e.g. `tar -xzf <file>.tgz`), run `npm install --omit=dev --ignore-scripts` in the extracted `package/` directory, and pass that directory to --sdk."
        : `Run \`npm install --omit=dev --ignore-scripts\` in ${opts.sdk}, then restart oag-mcp.`;
    throw new OagMcpError(
      "SDK_DEPENDENCIES_MISSING",
      `SDK runtime dependencies are not installed: ${missing.join(", ")}`,
      {
        hint: `oag-mcp never installs packages or runs package scripts. ${how}`,
        details: { missing },
      },
    );
  }
  opts.logs.op("info", "prepare.compat.checked", {
    layout: insp.layout,
    oagVersion: insp.oagVersion,
    oagVersionTested: insp.oagVersionTested,
    apiFiles: insp.apiFiles.length,
    outcome: "success",
  });
  return insp;
}

/**
 * Stage 3: declarations, execution bundle, TypeScript libs and the runner.
 *
 * @private
 */
async function _sdk(
  insp: SdkInspection,
  staged: StagedSdk,
  ws: Workspace,
  logs: Logs,
): Promise<{ typesDir: string; warnings: string[] }> {
  const warnings: string[] = [];
  const typesDir = path.join(ws.dir, WORKSPACE_PATHS.types);
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
  const classNames = [...scanImplementation(insp.apiFiles).keys()];
  const bundle = await bundleSdk({
    entry: insp.entry,
    root: staged.root,
    outFile: path.join(ws.dir, WORKSPACE_PATHS.bundle),
    shimDir: path.join(ws.dir, WORKSPACE_PATHS.shim),
    classNames,
  });
  logs.op("info", "prepare.sdk.bundled", {
    bytes: bundle.bytes,
    exports: bundle.exports.length,
  });
  copyTsLibs(path.join(ws.dir, WORKSPACE_PATHS.tsLib));
  fs.mkdirSync(path.dirname(path.join(ws.dir, WORKSPACE_PATHS.runner)), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(packageRoot(), "assets", "deno-runner.js"),
    path.join(ws.dir, WORKSPACE_PATHS.runner),
  );
  return { typesDir, warnings };
}

/**
 * Stage 4: method index and the `sdk` binding declaration.
 *
 * @private
 */
function _index(
  spec: SpecSummary,
  insp: SdkInspection,
  typesDir: string,
  ws: Workspace,
  logs: Logs,
): {
  records: MethodRecord[];
  bindings: OperationBinding[];
  unmapped: Array<{ key: string; operationId?: string }>;
  index: MethodSearchIndex;
  warnings: string[];
} {
  const impl = scanImplementation(insp.apiFiles);
  const analyzer = new SdkAnalyzer(path.join(typesDir, "index.d.ts"));
  const byKey = new Map(spec.operations.map((o) => [o.key, o]));
  const methods = analyzer.analyze(impl, (m, p) =>
    hintsForOperation(byKey.get(`${m} ${p}`)),
  );
  const { records, bindings, unmapped } = buildRecords(spec, methods);
  const warnings = unmapped.map(
    (u) =>
      `Operation ${u.key}${u.operationId ? ` (${u.operationId})` : ""} has no SDK method and is not available`,
  );
  fs.writeFileSync(
    path.join(ws.dir, WORKSPACE_PATHS.binding),
    bindingDeclaration(records),
  );
  const index = new MethodSearchIndex(records);
  logs.op("info", "prepare.index.created", {
    methods: records.length,
    apiClasses: new Set(records.map((r) => r.className)).size,
    unmappedOperations: unmapped.length,
  });
  return { records, bindings, unmapped, index, warnings };
}

/**
 * Prepare the SDK for serving: stages 1–4. On failure the workspace is
 * removed before the error is rethrown.
 *
 * @param {Object} opts - preparation options
 * @return {Promise} prepared SDK
 */
export async function prepareSdk(opts: PrepareOptions): Promise<PreparedSdk> {
  const { logs } = opts;
  const started = Date.now();
  const prepareId = crypto.randomUUID();
  logs.op("info", "prepare.started", { prepareId });
  const ws = createWorkspace({ root: opts.workspaceRoot, logs });
  try {
    const { specPath, spec, staged } = await runStage(logs, "inputs", () =>
      _inputs(opts, ws),
    );
    const insp = await runStage(logs, "compatibility", () =>
      _compatibility(opts, staged),
    );
    const sdk = await runStage(logs, "sdk", () => _sdk(insp, staged, ws, logs));
    const idx = await runStage(logs, "index", () =>
      _index(spec, insp, sdk.typesDir, ws, logs),
    );
    const warnings = [...insp.warnings, ...sdk.warnings, ...idx.warnings];
    for (const w of warnings) {
      logs.op("warn", "prepare.warning", { warning: w });
    }
    const info: PreparedSdkInfo = {
      prepareId,
      preparedAt: new Date().toISOString(),
      oagMcpVersion: oagMcpVersion(),
      target: {
        generator: "typescript-fetch",
        oagVersion: insp.oagVersion,
        oagVersionTested: insp.oagVersionTested,
        options: insp.detectedOptions,
        sdkLayout: insp.layout,
        sdkPackage: insp.pkg
          ? { name: insp.pkg.name, version: insp.pkg.version }
          : undefined,
      },
      tools: {
        typescript: dependencyVersion("typescript"),
        esbuild: dependencyVersion("esbuild"),
      },
      inputs: {
        spec: {
          fileName: path.basename(specPath),
          sha256: sha256File(specPath),
        },
        sdk: { kind: staged.kind, sha256: staged.sha256 },
      },
      api: {
        title: spec.title,
        version: spec.apiVersion,
        description: spec.description,
        servers: spec.servers,
        tags: spec.tags,
      },
      securitySchemes: spec.securitySchemes,
      operations: idx.bindings,
      unmappedOperations: idx.unmapped,
    };
    logs.op("info", "prepare.sdk.prepared", {
      prepareId,
      methods: idx.records.length,
      oagVersion: insp.oagVersion,
      sdkLayout: insp.layout,
      sdkKind: staged.kind,
      specSha256: info.inputs.spec.sha256,
      sdkSha256: staged.sha256,
      durationMs: Date.now() - started,
    });
    return {
      info,
      workspaceDir: ws.dir,
      records: idx.records,
      bindings: idx.bindings,
      index: idx.index,
      warnings,
      cleanup: ws.cleanup,
    };
  } catch (err) {
    logs.op("error", "prepare.failed", {
      prepareId,
      errorCode: err instanceof OagMcpError ? err.code : "UNEXPECTED",
      durationMs: Date.now() - started,
      outcome: "failure",
    });
    ws.cleanup();
    throw err;
  }
}
