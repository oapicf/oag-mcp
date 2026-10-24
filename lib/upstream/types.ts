"use strict";
/**
 * Upstream credential provider interfaces. The provider is replaceable: the
 * request broker depends only on {@link CredentialProvider}, never on how
 * credentials are configured or obtained.
 *
 * @module upstream/types
 */
import type { Logs } from "../logger.js";
import type {
  OperationBinding,
  Principal,
  SecuritySchemeInfo,
} from "../types.js";

/** Context passed to credential providers. */
export interface CredentialContext {
  principal: Principal;
  operation: OperationBinding;
  executionId?: string;
  requestId?: string;
  logs: Logs;
  signal?: AbortSignal;
}

/** Credentials applied to one outgoing request. */
export interface AppliedCredential {
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** Provider boundary for upstream credentials. */
export interface CredentialProvider {
  readonly id: string;
  /** Whether credentials are configured for the scheme. */
  has(schemeName: string): boolean;
  /** Produce credentials for one scheme. */
  apply(
    scheme: SecuritySchemeInfo,
    scopes: string[],
    ctx: CredentialContext,
  ): Promise<AppliedCredential>;
  /** Forget cached credentials after the upstream rejected them. */
  invalidate(schemeName: string, ctx: CredentialContext): void;
}
