"use strict";
/**
 * Stage an existing SDK input (package directory or npm package archive)
 * into a private working copy. The supplied SDK is never modified.
 *
 * @module build/sdk-input
 */
import fs from "node:fs";
import path from "node:path";

import * as tar from "tar";

import { OagMcpError } from "../errors.js";
import { sha256File, sha256Tree } from "../util/hash.js";

/** Limits applied when extracting archives. */
export const ARCHIVE_LIMITS = {
  maxEntries: 20000,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** Entry types allowed in SDK archives. */
const ALLOWED_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
]);

/** Result of staging an SDK input. */
export interface StagedSdk {
  /** Root of the working copy (directory containing package.json/src). */
  root: string;
  kind: "directory" | "archive";
  /** Hash of the original input (archive bytes or directory tree). */
  sha256: string;
}

const IGNORED_TREE_ENTRIES = new Set([".git", "node_modules"]);

/**
 * Validate an archive entry path, returning a reason when unsafe.
 *
 * @param {String} entryPath - path recorded in the archive
 * @return {String|undefined} rejection reason
 */
export function unsafeArchivePath(entryPath: string): string | undefined {
  if (!entryPath || entryPath.includes("\0")) {
    return "empty or NUL-containing path";
  }
  if (
    entryPath.startsWith("/") ||
    entryPath.startsWith("\\") ||
    /^[a-zA-Z]:/.test(entryPath)
  ) {
    return "absolute path";
  }
  const segments = entryPath.split(/[\\/]+/);
  if (segments.includes("..")) {
    return "parent directory traversal";
  }
  return undefined;
}

/**
 * Extract an npm package archive safely into `dest`.
 *
 * Entries are validated before extraction: absolute paths, `..` traversal,
 * links, devices and FIFOs are rejected, and entry count and total size are
 * bounded. After extraction every path is checked to resolve inside `dest`.
 *
 * @param {String} archive - path to the .tgz archive
 * @param {String} dest - empty destination directory
 * @return {Promise} absolute path of the package root inside `dest`
 */
export async function extractArchive(
  archive: string,
  dest: string,
): Promise<string> {
  const problems: string[] = [];
  let count = 0;
  let total = 0;
  const topLevel = new Set<string>();
  try {
    await tar.t({
      file: archive,
      strict: true,
      onReadEntry: (entry) => {
        count++;
        total += entry.size ?? 0;
        const reason = unsafeArchivePath(entry.path);
        if (reason) {
          problems.push(`${entry.path}: ${reason}`);
        }
        if (!ALLOWED_ENTRY_TYPES.has(String(entry.type))) {
          problems.push(`${entry.path}: entry type ${entry.type} not allowed`);
        }
        topLevel.add(entry.path.split(/[\\/]+/)[0]);
      },
    });
  } catch (err) {
    throw new OagMcpError(
      "SDK_ARCHIVE_INVALID",
      `SDK archive ${archive} could not be read: ${(err as Error).message}`,
      {
        hint: "Provide a gzip-compressed npm package archive, e.g. created with `npm pack`.",
        cause: err,
      },
    );
  }
  if (count > ARCHIVE_LIMITS.maxEntries) {
    problems.push(`too many entries (${count} > ${ARCHIVE_LIMITS.maxEntries})`);
  }
  if (total > ARCHIVE_LIMITS.maxTotalBytes) {
    problems.push(
      `uncompressed size too large (${total} > ${ARCHIVE_LIMITS.maxTotalBytes} bytes)`,
    );
  }
  if (problems.length > 0) {
    throw new OagMcpError(
      "SDK_ARCHIVE_UNSAFE",
      `SDK archive ${archive} contains unsafe entries: ${problems.slice(0, 5).join("; ")}`,
      {
        hint: "Repack the SDK with `npm pack`; archives must not contain links, absolute paths or '..' segments.",
        details: { problems: problems.slice(0, 20) },
      },
    );
  }
  if (topLevel.size !== 1) {
    throw new OagMcpError(
      "SDK_ARCHIVE_LAYOUT",
      `SDK archive must contain a single top-level directory (found: ${[...topLevel].join(", ")})`,
      { hint: "npm pack archives contain a single `package/` directory." },
    );
  }
  fs.mkdirSync(dest, { recursive: true });
  await tar.x({
    file: archive,
    cwd: dest,
    strict: true,
    preservePaths: false,
    noChmod: true,
    filter: (_p, entry) =>
      ALLOWED_ENTRY_TYPES.has(String((entry as tar.ReadEntry).type)),
  });
  const realDest = fs.realpathSync(dest);
  const root = path.join(realDest, [...topLevel][0]);
  const check = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new OagMcpError(
          "SDK_ARCHIVE_UNSAFE",
          `Extracted archive contains a link: ${path.relative(realDest, abs)}`,
        );
      }
      const real = fs.realpathSync(abs);
      if (!real.startsWith(realDest + path.sep)) {
        throw new OagMcpError(
          "SDK_ARCHIVE_UNSAFE",
          `Extracted path escapes destination: ${path.relative(realDest, abs)}`,
        );
      }
      if (e.isDirectory()) {
        check(abs);
      }
    }
  };
  check(realDest);
  return root;
}

/**
 * Stage an SDK input into `workDir`.
 *
 * @param {String} input - SDK directory or .tgz archive path
 * @param {String} workDir - private working directory
 * @return {Promise} staged SDK
 */
export async function stageSdkInput(
  input: string,
  workDir: string,
): Promise<StagedSdk> {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    throw new OagMcpError("SDK_NOT_FOUND", `SDK path ${input} does not exist`, {
      hint: "Pass --sdk <directory|package.tgz> pointing at a typescript-fetch SDK, or use --generate-sdk.",
    });
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const dest = path.join(workDir, "sdk");
    fs.cpSync(abs, dest, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !IGNORED_TREE_ENTRIES.has(path.basename(src)),
    });
    // node_modules is copied separately only when present, so dependency
    // resolution works without reinstalling.
    const nm = path.join(abs, "node_modules");
    if (fs.existsSync(nm)) {
      fs.cpSync(nm, path.join(dest, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    return {
      root: dest,
      kind: "directory",
      sha256: sha256Tree(
        abs,
        (rel) => !rel.split("/").some((s) => IGNORED_TREE_ENTRIES.has(s)),
      ),
    };
  }
  if (/\.(tgz|tar\.gz)$/i.test(abs)) {
    const root = await extractArchive(abs, path.join(workDir, "archive"));
    return { root, kind: "archive", sha256: sha256File(abs) };
  }
  throw new OagMcpError(
    "SDK_INPUT_UNSUPPORTED",
    `SDK input ${input} is neither a directory nor a .tgz package archive`,
    {
      hint: "Use a generated SDK directory or an archive produced by `npm pack`.",
    },
  );
}
