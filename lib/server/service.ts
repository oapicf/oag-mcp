"use strict";
/**
 * The oag-mcp service: assembles the trusted bridge (credentials, policy,
 * request broker) and the isolated executor around an SDK prepared at
 * start-up, and implements the behaviour of the two MCP tools independent
 * of transport.
 *
 * @module server/service
 */
import crypto from "node:crypto";
import path from "node:path";

import { AuthorizationPolicy } from "./authorization.js";
import type { Config } from "../config.js";
import { SecretResolver } from "../util/secrets.js";
import { OagMcpError } from "../errors.js";
import { prepareCode } from "../executor/code-policy.js";
import { DenoExecutor, resolveDeno } from "../executor/deno-executor.js";
import { AgentTypeChecker } from "../executor/typecheck.js";
import type {
  ExecutionError,
  ExecutionOutcome,
  Executor,
  LogEntry,
} from "../executor/types.js";
import type { Logs } from "../logger.js";
import { boundValue, secrets } from "../util/redact.js";
import type { PreparedSdk } from "../prepare/prepare.js";
import { WORKSPACE_PATHS } from "../prepare/workspace.js";
import { type MethodSearchIndex, authLine } from "../search/search-index.js";
import type {
  MethodRecord,
  OperationBinding,
  PreparedSdkInfo,
  Principal,
} from "../types.js";
import { RequestBroker } from "../upstream/broker.js";
import { ServiceIdentityCredentialProvider } from "../upstream/credentials.js";
import { Semaphore } from "../util/semaphore.js";

/** Context of one tool invocation. */
export interface CallContext extends ClientEndpoint {
  principal: Principal;
  requestId: string;
  transport: "stdio" | "streamable-http";
  /** MCP session of a Streamable HTTP call. */
  mcpSessionId?: string;
  /** JSON-RPC id of the tool call request. */
  jsonrpcRequestId?: string | number;
}

/** Address and port of a Streamable HTTP client. */
export interface ClientEndpoint {
  clientAddress?: string;
  clientPort?: number;
}

/**
 * Context fields for the records of one tool call.
 *
 * @private
 */
function _callContext(
  ctx: CallContext,
  toolName: "search" | "execute",
): Record<string, unknown> {
  return {
    requestId: ctx.requestId,
    transport: ctx.transport,
    principalId: ctx.principal.id,
    clientAddress: ctx.clientAddress,
    clientPort: ctx.clientPort,
    mcpSessionId: ctx.mcpSessionId,
    jsonrpcRequestId: ctx.jsonrpcRequestId,
    toolName,
  };
}

/** Input of the search tool. */
export interface SearchInput {
  query?: string;
  id?: string;
  tag?: string;
  limit?: number;
}

/** Input of the execute tool. */
export interface ExecuteInput {
  code: string;
  language?: "typescript" | "javascript";
  timeoutMs?: number;
}

/** Output of the execute tool. */
export interface ExecuteOutput {
  ok: boolean;
  executionId: string;
  result?: unknown;
  logs: LogEntry[];
  logsTruncated: boolean;
  error?: ExecutionError;
  hint?: string;
  stats: { durationMs: number; sdkCalls: number };
}

const MAX_SEARCH_OUTPUT = 24000;

/** One execute call as it moves through its stages. */
interface Run {
  started: number;
  executionId: string;
  language: "typescript" | "javascript";
  ctx: CallContext;
  /** Logs carrying the call's context. */
  logs: Logs;
}

/** A call refused before the code runs. */
interface Refused {
  error: ExecutionError;
  hint?: string;
}

/** Code that passed the checks, as the module the sandbox runs. */
interface Checked {
  moduleBase64: string;
}

/**
 * Whether a stage refused the call.
 *
 * @private
 */
function _refused<T extends object>(value: T | Refused): value is Refused {
  return !("ok" in value) && !("moduleBase64" in value);
}

/**
 * Trim long text.
 *
 * @private
 */
function _clip(s: string | undefined, n: number): string | undefined {
  if (!s) {
    return s;
  }
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Prepared SDK plus runtime components, shared by every session of one
 * server process.
 */
export class OagMcpService {
  readonly info: PreparedSdkInfo;
  readonly index: MethodSearchIndex;
  readonly policy: AuthorizationPolicy;
  readonly broker: RequestBroker;
  readonly executor: Executor;
  private readonly bindings: Map<string, OperationBinding>;
  private readonly checker?: AgentTypeChecker;
  private readonly semaphore: Semaphore;

  /**
   * @param {Object} parts - assembled components (use {@link OagMcpService.create})
   */
  private constructor(
    readonly workspaceDir: string,
    readonly config: Config,
    readonly logs: Logs,
    parts: {
      info: PreparedSdkInfo;
      index: MethodSearchIndex;
      policy: AuthorizationPolicy;
      broker: RequestBroker;
      executor: Executor;
      checker?: AgentTypeChecker;
    },
  ) {
    this.info = parts.info;
    this.index = parts.index;
    this.policy = parts.policy;
    this.broker = parts.broker;
    this.executor = parts.executor;
    this.checker = parts.checker;
    this.bindings = new Map(parts.info.operations.map((o) => [o.id, o]));
    this.semaphore = new Semaphore(
      config.execution.maxConcurrent,
      config.execution.maxQueue,
    );
  }

  /**
   * Assemble the runtime around a prepared SDK: credential provider,
   * authorization policy, request broker, Deno executor (verified by
   * loading the bundle with every binding) and the type checker.
   *
   * @param {Object} opts - options
   * @return {Promise} service
   */
  static async create(opts: {
    prepared: PreparedSdk;
    config: Config;
    configBaseDir: string;
    logs: Logs;
    executor?: Executor;
    fetchImpl?: typeof fetch;
  }): Promise<OagMcpService> {
    const { config, logs, prepared } = opts;
    const dir = prepared.workspaceDir;
    const info = prepared.info;
    const index = prepared.index;

    const baseUrl = config.upstream.baseUrl ?? info.api.servers[0];
    let base: URL;
    try {
      base = new URL(baseUrl ?? "");
      if (base.protocol !== "http:" && base.protocol !== "https:") {
        throw new Error("protocol");
      }
    } catch {
      throw new OagMcpError(
        "CONFIG_BASE_URL_REQUIRED",
        `No absolute upstream base URL is available (spec servers: ${info.api.servers.join(", ") || "none"})`,
        { hint: "Set upstream.baseUrl in the configuration file." },
      );
    }
    const resolver = new SecretResolver({
      secretsFile: config.upstreamAuth.secretsFile,
      baseDir: opts.configBaseDir,
    });
    const provider = new ServiceIdentityCredentialProvider({
      schemes: config.upstreamAuth.schemes,
      schemeInfo: info.securitySchemes,
      resolver,
      registry: secrets,
      logs,
      allowInsecureTokenUrl: config.upstreamAuth.allowInsecureTokenUrl,
      baseUrl: base.toString(),
      fetchImpl: opts.fetchImpl,
    });
    const policy = new AuthorizationPolicy(config.authorization);
    logs.audit("authorization.policy_loaded", "success", {
      policyMode: policy.implicit ? "implicit-allow-all" : "configured",
      rules: config.authorization?.rules.length ?? 0,
      default: config.authorization?.default ?? "allow",
    });
    const broker = new RequestBroker({
      operations: info.operations,
      schemes: info.securitySchemes,
      provider,
      policy,
      network: { baseUrl: base.toString(), ...config.upstream },
      fetchImpl: opts.fetchImpl,
    });
    logs.audit("execution.policy.applied", "success", {
      upstreamOrigin: base.origin,
      extraRedirectOrigins: config.upstream.allowedOrigins.length,
      followRedirects: config.upstream.followRedirects,
      timeoutMs: config.execution.timeoutMs,
      memoryMb: config.execution.memoryMb,
      maxConcurrent: config.execution.maxConcurrent,
      sandbox: "deno-no-permissions",
    });
    let executor = opts.executor;
    if (!executor) {
      const deno = resolveDeno(config.execution.denoPath);
      logs.op("info", "executor.runtime.resolved", {
        executor: "deno-subprocess",
        denoVersion: deno.version,
        source: deno.source,
      });
      const denoExecutor = new DenoExecutor({ workspaceDir: dir, deno, logs });
      await denoExecutor.verify(info.operations, broker.sdkBasePath);
      logs.op("info", "executor.verified", {
        executor: "deno-subprocess",
        bindings: info.operations.length,
        outcome: "success",
      });
      executor = denoExecutor;
    }
    const checker = config.execution.typecheck
      ? new AgentTypeChecker(
          path.join(dir, "sdk"),
          path.join(dir, WORKSPACE_PATHS.tsLib),
        )
      : undefined;
    return new OagMcpService(dir, config, logs, {
      info,
      index,
      policy,
      broker,
      executor,
      checker,
    });
  }

  /** Warm caches (type checker) in the background. */
  warmUp(): void {
    setImmediate(() => {
      const started = Date.now();
      try {
        this.checker?.warmUp();
        this.logs.op("debug", "typecheck.warmed", {
          durationMs: Date.now() - started,
        });
      } catch (err) {
        this.logs.op("warn", "typecheck.warm_failed", {
          error: (err as Error).name,
        });
      }
    });
  }

  /**
   * Whether a record is visible to a principal.
   *
   * @private
   */
  private _visible(p: Principal): (r: MethodRecord) => boolean {
    return (r) => {
      const b = this.bindings.get(r.id);
      return Boolean(b) && this.policy.decide(p, b!).allowed;
    };
  }

  /**
   * Names of API classes visible to a principal (for tool descriptions).
   *
   * @return {Array} class names
   */
  apiClasses(): string[] {
    return [...new Set(this.info.operations.map((o) => o.className))].sort();
  }

  /**
   * Full description of one method record.
   *
   * @private
   */
  private _detail(r: MethodRecord): Record<string, unknown> {
    return {
      id: r.id,
      sdkPath: r.sdkPath,
      operationId: r.operationId,
      httpMethod: r.httpMethod,
      path: r.path,
      tags: r.tags,
      summary: r.summary,
      description: _clip(r.description, 1500),
      deprecated: r.deprecated || undefined,
      signature: r.signature,
      requiredArguments: r.requiredArguments,
      parameters: r.parameters,
      inputType: r.inputType?.declaration,
      returnType: r.returnType,
      referencedTypes: r.referencedTypes.map((t) => t.declaration),
      apiParameters: r.apiParameters.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.required,
        type: p.schemaType,
        description: _clip(p.description, 300),
      })),
      requestBody: r.requestBody
        ? {
            required: r.requestBody.required,
            contentTypes: r.requestBody.contentTypes,
            type: r.requestBody.schemaType,
          }
        : undefined,
      responses: r.responses,
      auth: authLine(r),
      example: r.example,
    };
  }

  /**
   * Run the search tool.
   *
   * @param {Object} input - search input
   * @param {Object} ctx - call context
   * @return {Object} search output
   */
  search(input: SearchInput, ctx: CallContext): Record<string, unknown> {
    const started = Date.now();
    const logs = this.logs.child(_callContext(ctx, "search"));
    const visible = this._visible(ctx.principal);
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    let mode: string;
    let out: Record<string, unknown>;
    if (input.id) {
      mode = "detail";
      const r = this.index.get(input.id);
      out =
        r && visible(r)
          ? { method: this._detail(r) }
          : {
              error: `No method with id "${input.id}" is available. Use search with a query to find ids.`,
            };
    } else if (input.query && input.query.trim()) {
      mode = "query";
      const { hits, total } = this.index.search(input.query.slice(0, 500), {
        visible,
        limit,
        tag: input.tag,
      });
      out = {
        results: hits,
        total,
        hint:
          hits.length === 0
            ? "No matches. Call search without a query to browse available APIs."
            : "Call search with { id } for full types and an example, then use execute.",
      };
    } else {
      mode = "browse";
      out = {
        api: {
          title: this.info.api.title,
          version: this.info.api.version,
        },
        apis: this.index.browse({ visible, perClass: 8, tag: input.tag }),
        hint: "Use search with a query or { tag: <ApiClass or tag> } to list methods; { id } for details.",
      };
    }
    // Bound output size: progressively drop detail.
    let text = JSON.stringify(out);
    if (text.length > MAX_SEARCH_OUTPUT && out.method) {
      const m = out.method as Record<string, unknown>;
      m.referencedTypes = (m.referencedTypes as string[]).slice(0, 3);
      m.apiParameters = undefined;
      text = JSON.stringify(out);
    }
    if (text.length > MAX_SEARCH_OUTPUT) {
      out = {
        truncated: true,
        note: "Result too large; narrow the query.",
        preview: text.slice(0, MAX_SEARCH_OUTPUT - 200),
      };
    }
    logs.op("info", "search.completed", {
      mode,
      results: Array.isArray(out.results) ? out.results.length : undefined,
      durationMs: Date.now() - started,
      outcome: "success",
    });
    return out;
  }

  /**
   * Run the execute tool: admit the call, check the code, run it in the
   * sandbox, then audit and report the outcome.
   *
   * @param {Object} input - execute input
   * @param {Object} ctx - call context
   * @return {Promise} execute output
   */
  async execute(input: ExecuteInput, ctx: CallContext): Promise<ExecuteOutput> {
    const executionId = `exec_${crypto.randomUUID()}`;
    const run: Run = {
      started: Date.now(),
      executionId,
      language: input.language ?? "typescript",
      ctx,
      logs: this.logs.child({ ..._callContext(ctx, "execute"), executionId }),
    };
    const checked = this._admit(input, run) ?? this._check(input, run);
    if (_refused(checked)) {
      return this._fail(run, checked.error, checked.hint);
    }
    const outcome = await this._run(input, run, checked.moduleBase64);
    if (_refused(outcome)) {
      return this._fail(run, outcome.error);
    }
    this._auditOutcome(run, outcome);
    return this._output(run, outcome);
  }

  /**
   * Refuse the call while required auditing is unavailable; otherwise
   * record the execution request.
   *
   * @private
   */
  private _admit(input: ExecuteInput, run: Run): Refused | undefined {
    const unavailable: Refused = {
      error: {
        type: "audit_unavailable",
        message:
          "Execution is disabled because required security auditing is unavailable",
      },
    };
    if (this.logs.auditBlocksExecution()) {
      return unavailable;
    }
    const recorded = run.logs.audit("execution.requested", "accepted", {
      language: run.language,
      codeBytes: Buffer.byteLength(input.code ?? ""),
    });
    if (!recorded && this.logs.failClosed) {
      return unavailable;
    }
    run.logs.op("info", "execution.started", { language: run.language });
    return undefined;
  }

  /**
   * Check the code against the code policy and, for TypeScript, the type
   * checker.
   *
   * @private
   */
  private _check(input: ExecuteInput, run: Run): Refused | Checked {
    const maxCodeBytes = this.config.execution.maxCodeBytes;
    const prepared = prepareCode(input.code ?? "", run.language, maxCodeBytes);
    if (!prepared.ok) {
      this._auditCodePolicy(run, prepared);
      return { error: prepared.error };
    }
    const diagnostics =
      run.language === "typescript"
        ? (this.checker?.check(input.code) ?? [])
        : [];
    if (diagnostics.length > 0) {
      return {
        error: {
          type: "type_error",
          message: `Code has ${diagnostics.length} type error(s): ${diagnostics[0].message} (line ${diagnostics[0].line})`,
          diagnostics,
        },
        hint: "Check method names, argument shapes and return types with search { id }.",
      };
    }
    return { moduleBase64: prepared.moduleBase64 };
  }

  /**
   * Audit code the code policy refused: imports, or code over the size
   * limit.
   *
   * @private
   */
  private _auditCodePolicy(
    run: Run,
    refused: Extract<ReturnType<typeof prepareCode>, { ok: false }>,
  ): void {
    if (refused.error.reason === "import_not_allowed") {
      run.logs.audit(
        "execution.import_denied",
        "denied",
        { violations: refused.violations?.length ?? 1 },
        "warn",
      );
    }
    if (refused.error.type === "resource_limit") {
      run.logs.audit(
        "execution.resource_limit",
        "denied",
        { limit: "maxCodeBytes", value: this.config.execution.maxCodeBytes },
        "warn",
      );
    }
  }

  /**
   * Run the code in the sandbox once a slot is free, with its SDK requests
   * going through the request broker for the caller.
   *
   * @private
   */
  private async _run(
    input: ExecuteInput,
    run: Run,
    moduleBase64: string,
  ): Promise<ExecutionOutcome | Refused> {
    const cfg = this.config.execution;
    const release = await this.semaphore.acquire();
    if (!release) {
      run.logs.audit(
        "execution.resource_limit",
        "denied",
        { limit: "maxConcurrent", value: cfg.maxConcurrent },
        "warn",
      );
      return {
        error: {
          type: "resource_limit",
          reason: "executor_busy",
          message: "Too many concurrent executions; retry shortly",
        },
      };
    }
    try {
      return await this.executor.execute({
        executionId: run.executionId,
        moduleBase64,
        bindings: this.info.operations,
        basePath: this.broker.sdkBasePath,
        limits: {
          timeoutMs: Math.min(
            Math.max(input.timeoutMs ?? cfg.timeoutMs, 100),
            cfg.maxTimeoutMs,
          ),
          memoryMb: cfg.memoryMb,
          maxSdkCalls: cfg.maxSdkCalls,
          maxResultBytes: cfg.maxResultBytes,
          maxLogBytes: cfg.maxLogBytes,
          maxLogEntries: 200,
          maxStdoutBytes: Math.max(cfg.maxResultBytes * 4, 8 * 1024 * 1024),
        },
        bridge: (req, signal) =>
          this.broker.handle(
            req,
            {
              principal: run.ctx.principal,
              executionId: run.executionId,
              requestId: run.ctx.requestId,
              logs: run.logs,
            },
            signal,
          ),
      });
    } finally {
      release();
    }
  }

  /**
   * Audit what the sandbox enforced: denied capabilities and result limits.
   *
   * @private
   */
  private _auditOutcome(run: Run, outcome: ExecutionOutcome): void {
    const error = outcome.error;
    if (
      error?.type === "permission_denied" &&
      error.reason === "sandbox_capability_denied"
    ) {
      run.logs.audit(
        "execution.capability_denied",
        "denied",
        { capability: error.capability ?? "unknown" },
        "warn",
      );
    }
    if (
      error?.type === "output_limit" ||
      error?.type === "unsupported_result"
    ) {
      run.logs.audit(
        "execution.resource_limit",
        "denied",
        { limit: error.type },
        "warn",
      );
    }
  }

  /**
   * The tool output for an execution that ran, with any known secret that an
   * API response might echo back scrubbed.
   *
   * @private
   */
  private _output(run: Run, outcome: ExecutionOutcome): ExecuteOutput {
    const durationMs = () => Date.now() - run.started;
    run.logs.op(
      "info",
      outcome.ok ? "execution.completed" : "execution.failed",
      {
        durationMs: durationMs(),
        sdkCalls: outcome.stats.sdkCalls,
        terminated: outcome.stats.terminated,
        errorType: outcome.error?.type,
        outcome: outcome.ok ? "success" : "failure",
      },
    );
    return {
      ok: outcome.ok,
      executionId: run.executionId,
      result: outcome.ok
        ? JSON.parse(secrets.scrubKnown(JSON.stringify(outcome.result ?? null)))
        : undefined,
      logs: outcome.logs.map((l) => ({
        level: l.level,
        message: secrets.scrubKnown(l.message),
      })),
      logsTruncated: outcome.logsTruncated,
      error: outcome.error ? this._scrubError(outcome.error) : undefined,
      hint:
        outcome.ok && outcome.resultUndefined
          ? "The code returned no value; use `return` to send results back."
          : undefined,
      stats: { durationMs: durationMs(), sdkCalls: outcome.stats.sdkCalls },
    };
  }

  /**
   * The tool output for a call refused before or instead of running.
   *
   * @private
   */
  private _fail(run: Run, error: ExecutionError, hint?: string): ExecuteOutput {
    run.logs.op("info", "execution.failed", {
      errorType: error.type,
      reason: error.reason,
      durationMs: Date.now() - run.started,
      outcome: "failure",
    });
    return {
      ok: false,
      executionId: run.executionId,
      logs: [],
      logsTruncated: false,
      error: this._scrubError(error),
      hint,
      stats: { durationMs: Date.now() - run.started, sdkCalls: 0 },
    };
  }

  /**
   * Remove secrets from an execution error.
   *
   * @private
   */
  private _scrubError(e: ExecutionError): ExecutionError {
    return boundValue(e, { maxString: 4000, maxDepth: 4 }) as ExecutionError;
  }
}
