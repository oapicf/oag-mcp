"use strict";
/**
 * Hashing helpers used to identify preparation inputs.
 *
 * @module util/hash
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * SHA-256 of a buffer or string, hex encoded.
 *
 * @param {Buffer|String} data - data to hash
 * @return {String} hex digest
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 of a file's content.
 *
 * @param {String} file - file path
 * @return {String} hex digest
 */
export function sha256File(file: string): string {
  return sha256(fs.readFileSync(file));
}

/**
 * List files under a directory recursively, sorted, as relative POSIX paths.
 * Symbolic links are not followed.
 *
 * @param {String} dir - directory
 * @param {Function} [filter] - returns false to skip a relative path
 * @return {Array} relative file paths
 */
export function listFiles(
  dir: string,
  filter: (rel: string) => boolean = () => true,
): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (!filter(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Deterministic hash of a directory tree (relative paths and contents).
 *
 * @param {String} dir - directory
 * @param {Function} [filter] - returns false to skip a relative path
 * @return {String} hex digest
 */
export function sha256Tree(
  dir: string,
  filter?: (rel: string) => boolean,
): string {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(dir, filter)) {
    h.update(rel);
    h.update("\0");
    h.update(sha256File(path.join(dir, rel)));
    h.update("\n");
  }
  return h.digest("hex");
}
