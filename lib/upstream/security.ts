"use strict";
/**
 * Resolve the effective OpenAPI security requirement of an operation into
 * concrete credentials, honouring operation overrides and alternatives, and
 * never silently downgrading to unauthenticated access.
 *
 * @module upstream/security
 */
import type { SecurityRequirement, SecuritySchemeInfo } from "../types.js";
import {
  type AppliedCredential,
  type CredentialContext,
  type CredentialProvider,
  UpstreamAuthError,
} from "./credentials.js";

/** Result of credential resolution. */
export interface ResolvedSecurity extends AppliedCredential {
  /** Scheme names applied; empty when the call is unauthenticated. */
  schemes: string[];
  /** Index of the alternative used, -1 when none was required. */
  alternative: number;
}

/**
 * Choose and apply the first satisfiable security alternative.
 *
 * Alternatives are tried in document order, skipping the empty alternative
 * (`{}`, meaning "no authentication"), which is used only when no
 * authenticated alternative is configured. If the operation requires
 * authentication and no alternative is satisfiable, an error is raised.
 *
 * @param {Array} security - effective requirement alternatives
 * @param {Object} schemes - security scheme info
 * @param {Object} provider - credential provider
 * @param {Object} ctx - credential context
 * @return {Promise} resolved security
 */
export async function resolveSecurity(
  security: SecurityRequirement[],
  schemes: Record<string, SecuritySchemeInfo>,
  provider: CredentialProvider,
  ctx: CredentialContext,
): Promise<ResolvedSecurity> {
  if (security.length === 0) {
    return { headers: {}, query: {}, schemes: [], alternative: -1 };
  }
  const unsupported = new Set<string>();
  const unconfigured = new Set<string>();
  for (let i = 0; i < security.length; i++) {
    const names = Object.keys(security[i]);
    if (names.length === 0) {
      continue;
    }
    const usable = names.every((n) => {
      const s = schemes[n];
      if (!s || !s.supported) {
        unsupported.add(n);
        return false;
      }
      if (!provider.has(n)) {
        unconfigured.add(n);
        return false;
      }
      return true;
    });
    if (!usable) {
      continue;
    }
    const out: ResolvedSecurity = {
      headers: {},
      query: {},
      schemes: names,
      alternative: i,
    };
    for (const n of names) {
      const applied = await provider.apply(schemes[n], security[i][n], ctx);
      Object.assign(out.headers, applied.headers);
      Object.assign(out.query, applied.query);
    }
    return out;
  }
  if (security.some((r) => Object.keys(r).length === 0)) {
    return { headers: {}, query: {}, schemes: [], alternative: -1 };
  }
  if (unconfigured.size === 0 && unsupported.size > 0) {
    throw new UpstreamAuthError(
      "unsupported_scheme",
      `This operation requires security schemes oag-mcp cannot satisfy: ${[...unsupported].join(", ")}`,
    );
  }
  throw new UpstreamAuthError(
    "credential_not_configured",
    `No upstream credentials are configured for this operation; configure one of: ${security
      .map((r) => Object.keys(r).join(" + "))
      .filter(Boolean)
      .join(" | ")} under upstreamAuth.schemes`,
  );
}
