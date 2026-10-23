"use strict";
/**
 * Compatibility checks for OpenAPI Generator typescript-fetch SDKs.
 *
 * oag-mcp only supports typescript-fetch output from a tested set of
 * generator versions and options. This module detects the SDK layout
 * (TypeScript sources or compiled JavaScript with declarations), the
 * generator version and the options that shape the generated code, and
 * rejects anything it cannot support with an actionable error.
 *
 * @module prepare/compat
 */
import fs from "node:fs";
import path from "node:path";

import { OagMcpError } from "../errors.js";
import {
  SUPPORTED_GENERATOR,
  SUPPORTED_OAG_VERSIONS,
} from "../util/version.js";

/** Options known to produce unsupported output. */
export const UNSUPPORTED_GENERATOR_OPTIONS: Record<string, string> = {
  sagasAndRecords:
    "generates redux-saga/immutablejs code that cannot run in the sandbox",
  dateLibrary:
    "only the default 'date' library is supported (Temporal is experimental)",
  withNodeImports: "not applicable to typescript-fetch",
  stringEnums:
    "TypeScript enums cannot be referenced from agent code (no imports); use the default union types",
};

/** Detected SDK layout. */
export interface SdkInspection {
  root: string;
  layout: "source" | "compiled";
  /** Directory containing runtime and apis/ implementation files. */
  implDir: string;
  /** Module bundled into the execution bundle. */
  entry: string;
  /** Directory containing compiled declarations (compiled layout only). */
  typesDir?: string;
  oagVersion: string;
  oagVersionTested: boolean;
  detectedOptions: Record<string, string | boolean>;
  pkg?: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
  };
  apiFiles: string[];
  warnings: string[];
}

/** Options for {@link inspectSdk}. */
export interface InspectOptions {
  layout?: "auto" | "source" | "compiled";
  declaredOagVersion?: string;
  allowUntestedOagVersion?: boolean;
}

const OTHER_GENERATOR_MARKERS: Array<[RegExp, string]> = [
  [/from ['"]axios['"]|globalAxios/, "typescript-axios"],
  [/@angular\/core/, "typescript-angular"],
  [/from ['"]rxjs['"]/, "typescript-rxjs"],
  [/localVarRequest|from ['"]request['"]/, "typescript-node"],
  [/from ['"]jquery['"]/, "typescript-jquery"],
  [/ObservableAPI|PromiseAPI/, "typescript"],
];

/**
 * Read a file if it exists.
 *
 * @private
 */
function _read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * List API implementation files in `<implDir>/apis`.
 *
 * @private
 */
function _apiFiles(implDir: string, ext: "ts" | "js"): string[] {
  const dir = path.join(implDir, "apis");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(`.${ext}`) &&
        !f.endsWith(".d.ts") &&
        !/^index\.(ts|js)$/.test(f) &&
        !/Sagas\.(ts|js)$/.test(f) &&
        f !== "SagaApiManager.ts" &&
        f !== "allSagas.ts",
    )
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Verify the runtime module is typescript-fetch output.
 *
 * @private
 */
function _checkRuntime(runtimeFile: string, root: string): void {
  const text = _read(runtimeFile);
  if (text === undefined) {
    throw new OagMcpError(
      "SDK_LAYOUT_UNSUPPORTED",
      `typescript-fetch runtime module not found in ${root}`,
      {
        hint: "Expected src/runtime.ts (sources) or dist/runtime.js with dist/runtime.d.ts (compiled). Only OpenAPI Generator typescript-fetch SDKs are supported.",
      },
    );
  }
  for (const [re, gen] of OTHER_GENERATOR_MARKERS) {
    if (re.test(text)) {
      throw new OagMcpError(
        "SDK_GENERATOR_UNSUPPORTED",
        `The SDK in ${root} looks like OpenAPI Generator "${gen}" output`,
        {
          hint: `Only the ${SUPPORTED_GENERATOR} generator is supported. Regenerate the SDK with OpenAPI Generator -g ${SUPPORTED_GENERATOR}.`,
        },
      );
    }
  }
  const markers = ["BaseAPI", "Configuration", "fetchApi", "ResponseError"];
  const missing = markers.filter((m) => !text.includes(m));
  if (missing.length > 0) {
    throw new OagMcpError(
      "SDK_GENERATOR_UNSUPPORTED",
      `The SDK runtime in ${root} is missing typescript-fetch markers: ${missing.join(", ")}`,
      {
        hint: `Only OpenAPI Generator ${SUPPORTED_GENERATOR} SDKs are supported.`,
      },
    );
  }
}

/**
 * Detect generator options from the generated code.
 *
 * @private
 */
function _detectOptions(
  implDir: string,
  apiFiles: string[],
  declarationText: string,
): Record<string, string | boolean> {
  const opts: Record<string, string | boolean> = {};
  const apiText = apiFiles.map((f) => _read(f) ?? "").join("\n");
  opts.withInterfaces = /ApiInterface\b/.test(apiText + declarationText);
  const modelDir = path.join(implDir, "models");
  const modelText = fs.existsSync(modelDir)
    ? fs
        .readdirSync(modelDir)
        .map((f) => _read(path.join(modelDir, f)) ?? "")
        .join("\n")
    : "";
  opts.withoutRuntimeChecks = !/FromJSON/.test(apiText + modelText);
  opts.importFileExtension = /from ['"]\.\.?\/[^'"]+\.js['"]/.test(apiText)
    ? ".js"
    : "";
  const base = apiFiles.map((f) => path.basename(f));
  opts.fileNaming = base.some((b) => b.includes("-"))
    ? "kebab-case"
    : base.some((b) => /^[a-z]/.test(b))
      ? "camelCase"
      : "PascalCase";
  return opts;
}

/**
 * Determine the generator version recorded in `.openapi-generator/VERSION`.
 *
 * @private
 */
function _oagVersion(
  root: string,
  opts: InspectOptions,
): { version: string; tested: boolean } {
  const recorded = _read(path.join(root, ".openapi-generator", "VERSION"));
  const version = (recorded ?? opts.declaredOagVersion ?? "").trim();
  if (!version) {
    throw new OagMcpError(
      "SDK_OAG_VERSION_UNKNOWN",
      `Cannot determine the OpenAPI Generator version of the SDK in ${root}`,
      {
        hint: "The generator writes .openapi-generator/VERSION. If it was removed, pass --sdk-oag-version <version> to declare it.",
      },
    );
  }
  if (
    recorded &&
    opts.declaredOagVersion &&
    recorded.trim() !== opts.declaredOagVersion
  ) {
    throw new OagMcpError(
      "SDK_OAG_VERSION_CONFLICT",
      `--sdk-oag-version ${opts.declaredOagVersion} conflicts with .openapi-generator/VERSION ${recorded.trim()}`,
    );
  }
  const tested = (SUPPORTED_OAG_VERSIONS as readonly string[]).includes(
    version,
  );
  if (!tested && !opts.allowUntestedOagVersion) {
    throw new OagMcpError(
      "SDK_OAG_VERSION_UNSUPPORTED",
      `OpenAPI Generator ${version} is not in the tested set (${SUPPORTED_OAG_VERSIONS.join(", ")})`,
      {
        hint: `Regenerate the SDK with a tested OpenAPI Generator version (${SUPPORTED_OAG_VERSIONS.join(", ")}), or pass --allow-untested-oag-version to proceed at your own risk.`,
      },
    );
  }
  return { version, tested };
}

/**
 * Inspect an SDK working copy and verify it is supported.
 *
 * @param {String} root - SDK working copy root
 * @param {Object} [opts] - inspection options
 * @return {Object} inspection result
 */
export function inspectSdk(
  root: string,
  opts: InspectOptions = {},
): SdkInspection {
  const warnings: string[] = [];
  const pkgText = _read(path.join(root, "package.json"));
  let pkg: SdkInspection["pkg"];
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      throw new OagMcpError(
        "SDK_PACKAGE_INVALID",
        `package.json in ${root} is not valid JSON`,
      );
    }
  } else {
    warnings.push(
      "SDK has no package.json (generated without npmName); it can still be imported by path.",
    );
  }
  const pkgDeps = JSON.stringify(
    (pkg as Record<string, unknown> | undefined)?.dependencies ?? {},
  );
  if (/redux-saga|immutable/.test(pkgDeps)) {
    throw new OagMcpError(
      "SDK_OPTION_UNSUPPORTED",
      "The SDK was generated with sagasAndRecords, which is not supported",
      { hint: UNSUPPORTED_GENERATOR_OPTIONS.sagasAndRecords },
    );
  }

  const sourceDirs = [path.join(root, "src"), root];
  const sourceDir = sourceDirs.find(
    (d) =>
      fs.existsSync(path.join(d, "runtime.ts")) &&
      fs.existsSync(path.join(d, "index.ts")),
  );
  let compiled: { implDir: string; entry: string; typesDir: string } | null =
    null;
  const p = (pkg ?? {}) as Record<string, string>;
  const typesFile = p.types ?? p.typings ?? "dist/index.d.ts";
  const typesDir = path.dirname(path.join(root, typesFile));
  for (const entryRel of [p.module, p.main, "dist/index.js"].filter(Boolean)) {
    const entry = path.join(root, entryRel);
    const implDir = path.dirname(entry);
    if (
      fs.existsSync(entry) &&
      fs.existsSync(path.join(implDir, "runtime.js")) &&
      fs.existsSync(path.join(typesDir, "index.d.ts"))
    ) {
      compiled = { implDir, entry, typesDir };
      break;
    }
  }

  const wanted = opts.layout ?? "auto";
  let layout: "source" | "compiled";
  if (wanted === "source" || (wanted === "auto" && sourceDir)) {
    if (!sourceDir) {
      throw new OagMcpError(
        "SDK_LAYOUT_UNSUPPORTED",
        `No typescript-fetch sources (src/index.ts, src/runtime.ts) found in ${root}`,
        {
          hint: "Use --sdk-layout compiled for packages that ship only dist/.",
        },
      );
    }
    layout = "source";
  } else if (compiled) {
    layout = "compiled";
  } else {
    throw new OagMcpError(
      "SDK_LAYOUT_UNSUPPORTED",
      `Unrecognised SDK layout in ${root}`,
      {
        hint: "Expected typescript-fetch sources (src/index.ts, src/runtime.ts, src/apis/) or a compiled package (dist/index.js, dist/runtime.js, dist/index.d.ts). See docs/sdk-compatibility.md.",
      },
    );
  }

  const implDir = layout === "source" ? sourceDir! : compiled!.implDir;
  const ext = layout === "source" ? "ts" : "js";
  _checkRuntime(path.join(implDir, `runtime.${ext}`), root);
  if (
    fs.existsSync(path.join(implDir, "ApiEntitiesRecord.ts")) ||
    fs.existsSync(path.join(implDir, "apis", "allSagas.ts"))
  ) {
    throw new OagMcpError(
      "SDK_OPTION_UNSUPPORTED",
      "The SDK was generated with sagasAndRecords, which is not supported",
      { hint: UNSUPPORTED_GENERATOR_OPTIONS.sagasAndRecords },
    );
  }
  const runtimeText = _read(path.join(implDir, `runtime.${ext}`)) ?? "";
  const modelsDir = path.join(implDir, "models");
  const enumDecl = fs.existsSync(modelsDir)
    ? fs
        .readdirSync(modelsDir)
        .some((f) =>
          /export (declare )?enum |exports\.\w+ = \{\};\s*\(function \(/.test(
            _read(path.join(modelsDir, f)) ?? "",
          ),
        )
    : false;
  if (enumDecl) {
    throw new OagMcpError(
      "SDK_OPTION_UNSUPPORTED",
      "The SDK was generated with stringEnums=true, which is not supported",
      { hint: UNSUPPORTED_GENERATOR_OPTIONS.stringEnums },
    );
  }
  if (/Temporal\./.test(runtimeText)) {
    throw new OagMcpError(
      "SDK_OPTION_UNSUPPORTED",
      "The SDK was generated with dateLibrary=temporal, which is not supported",
      { hint: UNSUPPORTED_GENERATOR_OPTIONS.dateLibrary },
    );
  }
  const apiFiles = _apiFiles(implDir, ext);
  if (apiFiles.length === 0) {
    throw new OagMcpError(
      "SDK_LAYOUT_UNSUPPORTED",
      `No API classes found in ${path.join(implDir, "apis")}`,
      {
        hint: "The SDK must contain generated API classes (apis/*Api). Check that the spec has operations and that generation succeeded.",
      },
    );
  }
  const { version, tested } = _oagVersion(root, opts);
  if (!tested) {
    warnings.push(
      `OpenAPI Generator ${version} is untested; proceeding because --allow-untested-oag-version was given.`,
    );
  }
  const declText =
    layout === "compiled"
      ? fs
          .readdirSync(path.join(compiled!.typesDir, "apis"))
          .filter((f) => f.endsWith(".d.ts"))
          .map((f) => _read(path.join(compiled!.typesDir, "apis", f)) ?? "")
          .join("\n")
      : "";
  return {
    root,
    layout,
    implDir,
    entry:
      layout === "source" ? path.join(sourceDir!, "index.ts") : compiled!.entry,
    typesDir: layout === "compiled" ? compiled!.typesDir : undefined,
    oagVersion: version,
    oagVersionTested: tested,
    detectedOptions: _detectOptions(implDir, apiFiles, declText),
    pkg: pkg
      ? {
          name: (pkg as Record<string, string>).name,
          version: (pkg as Record<string, string>).version,
          dependencies: (pkg as { dependencies?: Record<string, string> })
            .dependencies,
        }
      : undefined,
    apiFiles,
    warnings,
  };
}
