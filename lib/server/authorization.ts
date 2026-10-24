"use strict";
/**
 * Request-scoped principals and the operation authorisation policy.
 *
 * Authorisation is enforced twice: search results are filtered to what the
 * caller may use, and every SDK call made during an execution is checked by
 * the host broker before it reaches the upstream API. Hiding a method from
 * search is not the control; the broker check is.
 *
 * @module server/authorization
 */
import crypto from "node:crypto";

import type { AuthorizationRule } from "../config.js";
import type { OperationBinding, Principal } from "../types.js";

/**
 * Derive an opaque, stable principal id from identifying values.
 *
 * @param {String} kind - principal kind
 * @param {Array} parts - identifying values (e.g. issuer and subject)
 * @return {String} opaque id
 */
export function opaquePrincipalId(kind: string, parts: string[]): string {
  const h = crypto
    .createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}:${h}`;
}

/** Authorisation decision. */
export interface Decision {
  allowed: boolean;
  policyId: string;
  reason: string;
}

/**
 * Convert a glob with `*` wildcards to a regular expression.
 *
 * @private
 */
function _glob(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Whether an operation pattern matches a binding. Patterns are globs over
 * binding ids ("PetsApi.list*"), `tag:<name>`, `method:<HTTP>` or
 * `operationId:<glob>`.
 *
 * @param {String} pattern - pattern
 * @param {Object} op - operation binding
 * @return {Boolean} match
 */
export function matchesOperation(
  pattern: string,
  op: OperationBinding,
): boolean {
  if (pattern.startsWith("tag:")) {
    return op.tags.includes(pattern.slice(4));
  }
  if (pattern.startsWith("method:")) {
    return op.httpMethod === pattern.slice(7).toUpperCase();
  }
  if (pattern.startsWith("operationId:")) {
    return (
      Boolean(op.operationId) && _glob(pattern.slice(12)).test(op.operationId!)
    );
  }
  return _glob(pattern).test(op.id);
}

/**
 * Operation authorisation policy.
 */
export class AuthorizationPolicy {
  private readonly rules: AuthorizationRule[];
  private readonly defaultAllow: boolean;
  readonly implicit: boolean;

  /**
   * @param {Object} [config] - `authorization` configuration; undefined allows
   *   every operation for every authenticated principal ("implicit-allow-all")
   */
  constructor(config?: {
    default: "allow" | "deny";
    rules: AuthorizationRule[];
  }) {
    this.implicit = !config;
    this.rules = config?.rules ?? [];
    this.defaultAllow = config ? config.default === "allow" : true;
  }

  /**
   * Rules applying to a principal.
   *
   * @private
   */
  private _rulesFor(p: Principal): AuthorizationRule[] {
    return this.rules.filter((r) => {
      if (
        r.principals &&
        !r.principals.some(
          (g) =>
            _glob(g).test(p.id) ||
            (p.name !== undefined && _glob(g).test(p.name)),
        )
      ) {
        return false;
      }
      if (r.clientIds && !(p.clientId && r.clientIds.includes(p.clientId))) {
        return false;
      }
      if (r.scopes && !r.scopes.every((s) => p.scopes.includes(s))) {
        return false;
      }
      return true;
    });
  }

  /**
   * Decide whether a principal may invoke an operation.
   *
   * @param {Object} p - principal
   * @param {Object} op - operation binding
   * @return {Object} decision
   */
  decide(p: Principal, op: OperationBinding): Decision {
    if (this.implicit) {
      return {
        allowed: true,
        policyId: "implicit-allow-all",
        reason: "no_policy_configured",
      };
    }
    const rules = this._rulesFor(p);
    for (const r of rules) {
      if (r.deny.some((pat) => matchesOperation(pat, op))) {
        return { allowed: false, policyId: r.id, reason: "rule_deny" };
      }
    }
    for (const r of rules) {
      if (r.allow.some((pat) => matchesOperation(pat, op))) {
        return { allowed: true, policyId: r.id, reason: "rule_allow" };
      }
    }
    return {
      allowed: this.defaultAllow,
      policyId: "default",
      reason: this.defaultAllow ? "default_allow" : "default_deny",
    };
  }
}
