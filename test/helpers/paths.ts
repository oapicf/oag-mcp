"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. */
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Fixture directory. */
export const FIXTURES = path.join(ROOT, "test", "fixtures", "petclinic");

export const SPEC = path.join(FIXTURES, "openapi.yaml");
export const SDK_726 = path.join(FIXTURES, "sdk-7.26.0");
export const SDK_VARIANT = path.join(FIXTURES, "sdk-variant-7.26.0");
export const SDK_TGZ = path.join(FIXTURES, "petclinic-sdk-1.2.0.tgz");

/**
 * Create a temporary directory.
 *
 * @param {String} prefix - name prefix
 * @return {String} path
 */
export function tmpDir(prefix = "oag-mcp-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Copy a fixture SDK into a temporary directory for mutation.
 *
 * @param {String} src - fixture directory
 * @return {String} copy path
 */
export function copyFixture(src: string): string {
  const dest = path.join(tmpDir(), path.basename(src));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}
