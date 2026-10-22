// oag-mcp Deno executor runner.
//
// Runs inside a separate Deno process started with no permissions
// (no --allow-* flags), no remote or npm imports, and string code generation
// disabled. It loads the prepared SDK bundle, builds the `sdk` binding, runs
// one agent-submitted module, and talks to the trusted host over
// newline-delimited JSON on stdin/stdout.
//
// The real generated SDK runs here, but its fetchApi is a bridge: every HTTP
// request is sent to the host broker, which authorises the operation, applies
// the network policy, attaches upstream credentials and performs the request.
// Credentials never enter this process.
"use strict";
import * as SDK from "../sdk/sdk.bundle.js";

const encoder = new TextEncoder();
const stdout = Deno.stdout;
const pending = new Map();
let nextRid = 1;
let limits = {
  maxLogBytes: 16384,
  maxLogEntries: 200,
  maxResultBytes: 65536,
  maxDepth: 64,
};

function send(message) {
  stdout.writeSync(encoder.encode(JSON.stringify(message) + "\n"));
}

// ---------------------------------------------------------------------------
// Bounded console capture
const logs = [];
let logBytes = 0;
let logsTruncated = false;

function formatArg(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(toPlain(value, 0, new Set(), "$", true));
  } catch {
    return String(value);
  }
}

function makeConsole() {
  const capture =
    (level) =>
    (...args) => {
      if (logsTruncated) {
        return;
      }
      const message = args.map(formatArg).join(" ");
      if (
        logs.length >= limits.maxLogEntries ||
        logBytes + message.length > limits.maxLogBytes
      ) {
        logsTruncated = true;
        return;
      }
      logBytes += message.length;
      logs.push({ level, message });
    };
  // Not frozen: Deno's Node.js compatibility layer extends console lazily.
  return {
    log: capture("log"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
    debug: capture("debug"),
    trace: capture("debug"),
    table: capture("log"),
    dir: capture("log"),
  };
}

// ---------------------------------------------------------------------------
// Result serialisation: JSON-compatible values only.
class UnsupportedResultError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedResultError";
  }
}

function toPlain(value, depth, seen, at, lenient) {
  if (depth > limits.maxDepth) {
    throw new UnsupportedResultError(
      `value nested deeper than ${limits.maxDepth} levels at ${at}`,
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      if (lenient) return String(value);
      throw new UnsupportedResultError(`non-finite number (${value}) at ${at}`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    if (lenient) return `${value}n`;
    throw new UnsupportedResultError(
      `BigInt at ${at}; convert it with String() or Number()`,
    );
  }
  if (typeof value === "function" || typeof value === "symbol") {
    if (lenient) return `[${typeof value}]`;
    throw new UnsupportedResultError(`${typeof value} at ${at}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      if (lenient) return "Invalid Date";
      throw new UnsupportedResultError(`invalid Date at ${at}`);
    }
    return value.toISOString();
  }
  if (seen.has(value)) {
    if (lenient) return "[circular]";
    throw new UnsupportedResultError(`circular reference at ${at}`);
  }
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Promise ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    value instanceof Error
  ) {
    if (lenient) return `[${value.constructor?.name ?? "object"}]`;
    const name = value.constructor?.name ?? "object";
    const tip =
      value instanceof Map || value instanceof Set
        ? "; convert it with Array.from() or Object.fromEntries()"
        : value instanceof Promise
          ? "; did you forget await?"
          : "";
    throw new UnsupportedResultError(`${name} at ${at}${tip}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v, i) => {
        const out = toPlain(v, depth + 1, seen, `${at}[${i}]`, lenient);
        return out === undefined ? null : out;
      });
    }
    const out = {};
    for (const key of Object.keys(value)) {
      const v = toPlain(value[key], depth + 1, seen, `${at}.${key}`, lenient);
      if (v !== undefined) {
        out[key] = v;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Errors
class BrokerError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "OagMcpBrokerError";
    this.oagMcp = error;
  }
}

function agentLine(err) {
  const stack = typeof err?.stack === "string" ? err.stack : "";
  const m = /data:text\/javascript[^)\s]*:(\d+):(\d+)/.exec(stack);
  if (!m) {
    return undefined;
  }
  // One wrapper line precedes the agent code.
  const line = Number(m[1]) - 1;
  return line >= 1 ? { line, column: Number(m[2]) } : undefined;
}

const CAPABILITY = /Requires (\w+) access/;

async function classify(err) {
  let e = err;
  if (e && e.name === "FetchError" && e.cause) {
    e = e.cause;
  }
  if (!e || typeof e !== "object") {
    return { type: "runtime_error", name: "Error", message: String(e) };
  }
  const where = agentLine(err) ?? agentLine(e);
  if (e.oagMcp) {
    return { ...e.oagMcp, name: "OagMcpBrokerError" };
  }
  if (e instanceof UnsupportedResultError) {
    return { type: "unsupported_result", name: e.name, message: e.message };
  }
  if (e.name === "ResponseError" && e.response) {
    let body;
    try {
      const text = await e.response.text();
      body = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
    } catch {
      body = undefined;
    }
    return {
      type: "api_error",
      name: e.name,
      message:
        `The API responded with HTTP ${e.response.status} ${e.response.statusText ?? ""}`.trim(),
      status: e.response.status,
      body,
      ...(where ?? {}),
    };
  }
  if (e.name === "RequiredError") {
    return {
      type: "sdk_error",
      name: e.name,
      message: e.message,
      field: e.field,
      ...(where ?? {}),
    };
  }
  // Drop stack frames (they reveal sandbox paths) from nested messages.
  const message = String(e.message ?? e)
    .split(/\n\s+at /)[0]
    .replace(/file:\/\/\S+/g, "<sandbox>");
  const cap = CAPABILITY.exec(message);
  if (e.name === "NotCapable" || e.name === "PermissionDenied" || cap) {
    return {
      type: "permission_denied",
      name: e.name,
      reason: "sandbox_capability_denied",
      capability: cap ? cap[1] : "unknown",
      message: message.replace(/, run again with the --allow-\w+ flag/, ""),
      ...(where ?? {}),
    };
  }
  if (e.name === "EvalError" && /Code generation from strings/.test(message)) {
    return {
      type: "permission_denied",
      name: e.name,
      reason: "sandbox_capability_denied",
      capability: "eval",
      message: "eval and new Function are disabled in the sandbox",
      ...(where ?? {}),
    };
  }
  return {
    type: "runtime_error",
    name: e.name ?? "Error",
    message: message.length > 2000 ? `${message.slice(0, 2000)}…` : message,
    ...(where ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Bridge fetch
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i);
  }
  return out;
}

async function encodeBody(body) {
  if (body === undefined || body === null) {
    return { body: null };
  }
  if (typeof body === "string") {
    return { body, bodyEncoding: "utf8" };
  }
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      bodyEncoding: "utf8",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
    };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return {
      body: bytesToBase64(new Uint8Array(await body.arrayBuffer())),
      bodyEncoding: "base64",
      contentType: body.type || undefined,
    };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytesToBase64(bytes), bodyEncoding: "base64" };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    // Serialise multipart bodies with the platform encoder.
    const req = new Request("http://localhost/", { method: "POST", body });
    const bytes = new Uint8Array(await req.arrayBuffer());
    return {
      body: bytesToBase64(bytes),
      bodyEncoding: "base64",
      contentType: req.headers.get("content-type"),
    };
  }
  throw new TypeError("Unsupported request body type");
}

function headersToObject(headers) {
  const out = {};
  if (!headers) {
    return out;
  }
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      out[String(k)] = String(v);
    }
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      out[k] = String(v);
    }
  }
  return out;
}

function makeBridgeFetch(bindingId) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const encoded = await encodeBody(init.body);
    const headers = headersToObject(init.headers);
    if (
      encoded.contentType &&
      !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
    ) {
      headers["content-type"] = encoded.contentType;
    }
    const rid = nextRid++;
    const result = await new Promise((resolve) => {
      pending.set(rid, resolve);
      send({
        type: "fetch",
        rid,
        binding: bindingId,
        url,
        method: String(init.method ?? "GET").toUpperCase(),
        headers,
        body: encoded.body,
        bodyEncoding: encoded.bodyEncoding,
      });
    });
    if (!result.ok) {
      throw new BrokerError(result.error);
    }
    const status = result.status;
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : base64ToBytes(result.body ?? ""), {
      status,
      statusText: result.statusText ?? "",
      headers: result.headers ?? [],
    });
  };
}

// ---------------------------------------------------------------------------
// SDK binding
function buildSdk(bindings, basePath) {
  const classes = {};
  const missing = [];
  for (const b of bindings) {
    const Api = SDK[b.className];
    if (
      typeof Api !== "function" ||
      typeof Api.prototype?.[b.methodName] !== "function"
    ) {
      missing.push(b.id);
      continue;
    }
    classes[b.className] = classes[b.className] ?? {};
    classes[b.className][b.methodName] = (...args) => {
      // A fresh API instance per call keeps the binding id with the request,
      // including when calls run concurrently.
      const configuration = new SDK.Configuration({
        basePath,
        fetchApi: makeBridgeFetch(b.id),
      });
      return new Api(configuration)[b.methodName](...args);
    };
  }
  for (const k of Object.keys(classes)) {
    Object.freeze(classes[k]);
  }
  return { sdk: Object.freeze(classes), missing };
}

// ---------------------------------------------------------------------------
// Host message loop
async function* lines() {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        yield line;
      }
    }
  }
}

async function finish(message) {
  send({ ...message, type: "done", logs, logsTruncated });
  // Let the host close stdin; exiting here is the normal termination path.
  Deno.exit(0);
}

async function run(init) {
  limits = { ...limits, ...(init.limits ?? {}) };
  const { sdk, missing } = buildSdk(init.bindings ?? [], init.basePath);
  if (missing.length > 0) {
    await finish({
      ok: false,
      error: {
        type: "executor_error",
        name: "BindingMismatch",
        message: `SDK bundle does not provide: ${missing.slice(0, 10).join(", ")}`,
      },
    });
    return;
  }
  if (init.verifyOnly) {
    await finish({
      ok: true,
      result: { bindings: (init.bindings ?? []).length },
    });
    return;
  }
  // Workers would be able to load further local modules; agent code has no
  // legitimate use for them.
  for (const name of ["Worker", "SharedWorker"]) {
    try {
      delete globalThis[name];
    } catch {
      // ignore
    }
  }
  const console = makeConsole();
  // Route stray globalThis.console calls into the bounded capture as well,
  // so stdout carries only protocol messages.
  try {
    Object.defineProperty(globalThis, "console", {
      value: console,
      configurable: true,
      writable: true,
    });
  } catch {
    // ignore
  }
  let mod;
  try {
    mod = await import(`data:text/javascript;base64,${init.code}`);
  } catch (err) {
    await finish({
      ok: false,
      error: { ...(await classify(err)), type: "syntax_error" },
    });
    return;
  }
  try {
    const value = await mod.default(sdk, console);
    const plain = toPlain(value, 0, new Set(), "$", false);
    const json = JSON.stringify(plain === undefined ? null : plain);
    if (json.length > limits.maxResultBytes) {
      await finish({
        ok: false,
        error: {
          type: "output_limit",
          name: "OutputLimitExceeded",
          message: `Result is ${json.length} bytes; the limit is ${limits.maxResultBytes}. Filter or aggregate before returning.`,
          size: json.length,
          limit: limits.maxResultBytes,
        },
      });
      return;
    }
    await finish({
      ok: true,
      result: plain === undefined ? null : plain,
      resultUndefined: value === undefined,
    });
  } catch (err) {
    await finish({ ok: false, error: await classify(err) });
  }
}

let started = false;
for await (const line of lines()) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.type === "init" && !started) {
    started = true;
    // Do not await: fetch results must keep flowing while agent code runs.
    run(msg);
  } else if (msg.type === "fetchResult" && pending.has(msg.rid)) {
    const resolve = pending.get(msg.rid);
    pending.delete(msg.rid);
    resolve(msg);
  }
}
