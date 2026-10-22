"use strict";
/**
 * DEVELOPMENT TOOL (not part of the oag-mcp product or package): generate a
 * typescript-fetch SDK with OpenAPI Generator, using either a Java runtime
 * with the generator JAR or the official Docker image. Used to regenerate
 * test fixtures and by the optional generation integration tests.
 *
 * oag-mcp itself never generates SDKs and needs neither Java, Docker nor
 * OpenAPI Generator.
 *
 * Usage:
 *
 *     npx tsx scripts/dev/generate-sdk.ts --spec <file> --out <dir>
 *       [--oag-version 7.26.0] [--backend java|docker] [--jar <file>]
 *       [--props k=v,k2=v2]
 *
 * @module scripts/dev/generate-sdk
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { OagMcpError } from "../../lib/errors.js";
import { Logs } from "../../lib/logging/logger.js";
import { sha256File } from "../../lib/util/hash.js";
import {
  DEFAULT_OAG_VERSION,
  SUPPORTED_GENERATOR,
  SUPPORTED_OAG_VERSIONS,
} from "../../lib/version.js";

/** Maven Central location of the OpenAPI Generator CLI JAR. */
export const MAVEN_BASE =
  "https://repo1.maven.org/maven2/org/openapitools/openapi-generator-cli";

/** Docker image of the OpenAPI Generator CLI. */
export const DOCKER_IMAGE = "openapitools/openapi-generator-cli";

/** Generation request. */
export interface GenerateRequest {
  specPath: string;
  outDir: string;
  version: string;
  backend: "java" | "docker";
  jarPath?: string;
  additionalProperties: Record<string, string>;
  allowUntestedVersion?: boolean;
  logs: Logs;
}

/** Generation result. */
export interface GenerateResult {
  dir: string;
  version: string;
  backend: "java" | "docker";
  jarSha256?: string;
  dockerImage?: string;
}

/**
 * Cache directory for downloaded generator JARs.
 *
 * @return {String} directory
 */
export function cacheDir(): string {
  if (process.env.OAG_MCP_CACHE_DIR) {
    return process.env.OAG_MCP_CACHE_DIR;
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "oag-mcp");
}

/**
 * Path of the cached JAR for a version.
 *
 * @param {String} version - generator version
 * @return {String} path
 */
export function cachedJarPath(version: string): string {
  return path.join(
    cacheDir(),
    "openapi-generator",
    version,
    `openapi-generator-cli-${version}.jar`,
  );
}

/**
 * Check Java is available and recent enough.
 *
 * @return {String} detected version line
 */
export function checkJava(): string {
  const res = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    throw new OagMcpError(
      "OAG_JAVA_NOT_FOUND",
      "Java was not found; it is required for --oag-backend java",
      {
        hint: "Install a Java 11+ runtime (e.g. Eclipse Temurin) and make `java` available on PATH, or use --oag-backend docker.",
      },
    );
  }
  const text = `${res.stderr}\n${res.stdout}`;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text);
  const major = m ? parseInt(m[1] === "1" ? (m[2] ?? "0") : m[1], 10) : 0;
  if (major && major < 11) {
    throw new OagMcpError(
      "OAG_JAVA_TOO_OLD",
      `Java ${major} detected; OpenAPI Generator requires Java 11 or newer`,
      { hint: "Install Java 11+ or use --oag-backend docker." },
    );
  }
  return (
    text
      .split("\n")
      .find((l) => /version/.test(l))
      ?.trim() ?? "java"
  );
}

/**
 * Check Docker is available.
 *
 * @return {String} server version
 */
export function checkDocker(): string {
  const res = spawnSync(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) {
    throw new OagMcpError(
      "OAG_DOCKER_UNAVAILABLE",
      "Docker is not available; it is required for --oag-backend docker",
      {
        hint: "Install Docker and make sure the daemon is running (`docker version` must succeed), or use --oag-backend java.",
      },
    );
  }
  return res.stdout.trim();
}

/**
 * Download a URL to a file using the built-in fetch.
 *
 * @private
 */
async function _download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/**
 * Resolve the generator JAR: explicit path, OAG_MCP_OAG_JAR, cache, or a
 * checksum-verified download from Maven Central.
 *
 * @param {String} version - generator version
 * @param {String} [explicit] - --oag-jar path
 * @param {Logs} logs - logger
 * @return {Promise} JAR path
 */
export async function resolveJar(
  version: string,
  explicit: string | undefined,
  logs: Logs,
): Promise<string> {
  const candidate = explicit ?? process.env.OAG_MCP_OAG_JAR;
  if (candidate) {
    if (!fs.existsSync(candidate)) {
      throw new OagMcpError(
        "OAG_JAR_NOT_FOUND",
        `OpenAPI Generator JAR ${candidate} does not exist`,
      );
    }
    return path.resolve(candidate);
  }
  const cached = cachedJarPath(version);
  if (fs.existsSync(cached)) {
    return cached;
  }
  const url = `${MAVEN_BASE}/${version}/openapi-generator-cli-${version}.jar`;
  logs.op("info", "dev.oag.jar_download.started", {
    oagVersion: version,
    source: "maven-central",
  });
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const tmp = `${cached}.${crypto.randomUUID()}.tmp`;
  try {
    await _download(url, tmp);
    const shaRes = await fetch(`${url}.sha1`);
    if (!shaRes.ok) {
      throw new Error(`checksum unavailable (HTTP ${shaRes.status})`);
    }
    const expected = (await shaRes.text()).trim().split(/\s+/)[0];
    const actual = crypto
      .createHash("sha1")
      .update(fs.readFileSync(tmp))
      .digest("hex");
    if (expected !== actual) {
      throw new Error(
        `checksum mismatch (expected ${expected}, got ${actual})`,
      );
    }
    fs.renameSync(tmp, cached);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new OagMcpError(
      "OAG_JAR_DOWNLOAD_FAILED",
      `Could not download OpenAPI Generator ${version} from Maven Central: ${(err as Error).message}`,
      {
        hint: `Download openapi-generator-cli-${version}.jar manually and pass --jar <path> (or set OAG_MCP_OAG_JAR), or place it at ${cached}.`,
        cause: err,
      },
    );
  }
  logs.op("info", "dev.oag.jar_download.completed", {
    oagVersion: version,
    sha256: sha256File(cached),
  });
  return cached;
}

/**
 * Run a process, capturing bounded output.
 *
 * @private
 */
function _run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (d: Buffer) => {
      output += d.toString();
      if (output.length > 64 * 1024) {
        output = output.slice(-64 * 1024);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Format additional properties for the generator CLI.
 *
 * @param {Object} props - properties
 * @return {String} comma-separated key=value list
 */
export function formatAdditionalProperties(
  props: Record<string, string>,
): string {
  return Object.entries(props)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/**
 * Generate a typescript-fetch SDK.
 *
 * @param {Object} req - generation request
 * @return {Promise} generation result
 */
export async function generateSdk(
  req: GenerateRequest,
): Promise<GenerateResult> {
  if (
    !(SUPPORTED_OAG_VERSIONS as readonly string[]).includes(req.version) &&
    !req.allowUntestedVersion
  ) {
    throw new OagMcpError(
      "OAG_VERSION_UNSUPPORTED",
      `OpenAPI Generator ${req.version} is not in the tested set (${SUPPORTED_OAG_VERSIONS.join(", ")})`,
      {
        hint: "Use a tested --oag-version, or pass --allow-untested-oag-version to proceed at your own risk.",
      },
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(req.version)) {
    throw new OagMcpError(
      "OAG_VERSION_INVALID",
      `--oag-version must be an exact version such as 7.26.0 (got "${req.version}")`,
    );
  }
  fs.mkdirSync(req.outDir, { recursive: true });
  const specAbs = path.resolve(req.specPath);
  const props = formatAdditionalProperties(req.additionalProperties);
  const started = Date.now();
  req.logs.op("info", "dev.sdk.generation.started", {
    backend: req.backend,
    oagVersion: req.version,
    generator: SUPPORTED_GENERATOR,
  });
  let result: { code: number; output: string };
  let jarSha256: string | undefined;
  let dockerImage: string | undefined;
  if (req.backend === "java") {
    checkJava();
    const jar = await resolveJar(req.version, req.jarPath, req.logs);
    jarSha256 = sha256File(jar);
    const ver = await _run("java", ["-jar", jar, "version"]);
    const reported = ver.output.trim().split("\n").pop()?.trim();
    if (ver.code !== 0 || reported !== req.version) {
      throw new OagMcpError(
        "OAG_JAR_VERSION_MISMATCH",
        `The JAR at ${jar} reports version "${reported ?? "?"}", expected ${req.version}`,
        {
          hint: "Pass the JAR matching --oag-version, or change --oag-version.",
        },
      );
    }
    const args = [
      "-jar",
      jar,
      "generate",
      "-i",
      specAbs,
      "-g",
      SUPPORTED_GENERATOR,
      "-o",
      path.resolve(req.outDir),
    ];
    if (props) {
      args.push(`--additional-properties=${props}`);
    }
    result = await _run("java", args);
  } else {
    checkDocker();
    dockerImage = `${DOCKER_IMAGE}:v${req.version}`;
    const specDir = path.dirname(specAbs);
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      ...(typeof process.getuid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid?.() ?? 0}`]
        : []),
      "-v",
      `${specDir}:/spec:ro`,
      "-v",
      `${path.resolve(req.outDir)}:/out`,
      dockerImage,
      "generate",
      "-i",
      `/spec/${path.basename(specAbs)}`,
      "-g",
      SUPPORTED_GENERATOR,
      "-o",
      "/out",
    ];
    if (props) {
      args.push(`--additional-properties=${props}`);
    }
    result = await _run("docker", args);
    if (result.code !== 0 && /Unable to find image|pull/i.test(result.output)) {
      throw new OagMcpError(
        "OAG_DOCKER_IMAGE_UNAVAILABLE",
        `Docker image ${dockerImage} is not available locally and could not be pulled`,
        {
          hint: `Run \`docker pull ${dockerImage}\` with network access, or use --oag-backend java.`,
        },
      );
    }
  }
  if (result.code !== 0) {
    req.logs.op("error", "dev.sdk.generation.failed", {
      backend: req.backend,
      oagVersion: req.version,
      exitCode: result.code,
      durationMs: Date.now() - started,
    });
    const tail = result.output.split("\n").slice(-15).join("\n");
    throw new OagMcpError(
      "OAG_GENERATION_FAILED",
      `OpenAPI Generator exited with code ${result.code}:\n${tail}`,
      {
        hint: "Check that the spec is valid; generator output above shows the failing step.",
      },
    );
  }
  req.logs.op("info", "dev.sdk.generation.completed", {
    backend: req.backend,
    oagVersion: req.version,
    durationMs: Date.now() - started,
    outcome: "success",
  });
  return {
    dir: path.resolve(req.outDir),
    version: req.version,
    backend: req.backend,
    jarSha256,
    dockerImage,
  };
}

/**
 * Command-line entry point.
 *
 * @private
 */
async function _main(argv: string[]): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    args.set(argv[i].replace(/^--/, ""), argv[i + 1]);
  }
  if (!args.get("spec") || !args.get("out")) {
    process.stderr.write(
      "Usage: tsx scripts/dev/generate-sdk.ts --spec <file> --out <dir> [--oag-version x.y.z] [--backend java|docker] [--jar <file>] [--props k=v,...]\n",
    );
    process.exit(2);
  }
  const props: Record<string, string> = {};
  for (const kv of (args.get("props") ?? "").split(",").filter(Boolean)) {
    const idx = kv.indexOf("=");
    props[kv.slice(0, idx)] = kv.slice(idx + 1);
  }
  const res = await generateSdk({
    specPath: args.get("spec")!,
    outDir: args.get("out")!,
    version: args.get("oag-version") ?? DEFAULT_OAG_VERSION,
    backend: (args.get("backend") as "java" | "docker") ?? "java",
    jarPath: args.get("jar"),
    additionalProperties: props,
    logs: new Logs({ format: "pretty" }),
  });
  process.stderr.write(`Generated ${res.dir}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  _main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
