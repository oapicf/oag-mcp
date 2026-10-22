"use strict";
/**
 * Version information for oag-mcp and the tools it pins.
 *
 * @module version
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Exact OpenAPI Generator versions that oag-mcp is tested against. */
export const SUPPORTED_OAG_VERSIONS = ["7.25.0", "7.26.0"] as const;

/** Default OpenAPI Generator version used by `build --generate-sdk`. */
export const DEFAULT_OAG_VERSION = "7.26.0";

/** The only OpenAPI Generator target supported by this release. */
export const SUPPORTED_GENERATOR = "typescript-fetch";

/** Deno version range accepted by the executor. */
export const DENO_VERSION_RANGE = { min: "2.5.0", maxExclusive: "3.0.0" };

/** Artifact format version written to the manifest. */
export const ARTIFACT_FORMAT_VERSION = 1;

/** Service name used in structured logs. */
export const SERVICE_NAME = "oag-mcp";

let cachedVersion: string | undefined;

/**
 * Locate the oag-mcp package root by walking up from this module.
 *
 * @return {String} absolute directory containing oag-mcp's package.json
 */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (pkg.name === "oag-mcp") {
        return dir;
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error("Unable to locate the oag-mcp package root");
}

/**
 * Read the oag-mcp version from package.json.
 *
 * @return {String} version string
 */
export function oagMcpVersion(): string {
  if (!cachedVersion) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    );
    cachedVersion = pkg.version as string;
  }
  return cachedVersion;
}

/**
 * Read the installed version of a dependency.
 *
 * @param {String} name - package name
 * @return {String} version, or "unknown"
 */
export function dependencyVersion(name: string): string {
  try {
    const pkgPath = require.resolve(`${name}/package.json`);
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "unknown";
  }
}

/**
 * Compare two dotted numeric versions.
 *
 * @param {String} a - first version
 * @param {String} b - second version
 * @return {Number} negative, zero or positive
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
