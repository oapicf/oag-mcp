"use strict";
/**
 * Local lexical search over SDK method records using MiniSearch (BM25-style
 * full-text ranking, prefix and fuzzy matching), with English stop words
 * from the stopword package and Porter stemming from the stemmer package.
 * No embeddings or external services are involved.
 *
 * @module search/search-index
 */
import MiniSearch from "minisearch";
import { stemmer } from "stemmer";
import { eng } from "stopword";

import type { MethodRecord } from "../types.js";

/** Fields indexed for full-text search. */
const FIELDS = [
  "methodName",
  "methodWords",
  "className",
  "operationId",
  "summary",
  "description",
  "tags",
  "path",
  "params",
  "types",
];

const SEARCH_OPTIONS = {
  boost: {
    methodName: 3,
    methodWords: 3,
    operationId: 2,
    summary: 2.5,
    tags: 1.5,
    path: 1.5,
    className: 1.2,
    types: 0.5,
  },
  prefix: true,
  fuzzy: 0.2,
  combineWith: "OR" as const,
};

/**
 * Words in the stopword package's English list that carry meaning in API
 * search: "get" is a method-name verb (getPetById), and the others are
 * common query-parameter names (since, before, after, between, from).
 */
const API_TERMS = new Set([
  "get",
  "since",
  "before",
  "after",
  "between",
  "from",
]);

/** English stop words (the stopword package's list) minus API terms. */
const STOP_WORDS = new Set(eng.filter((w) => !API_TERMS.has(w)));

/**
 * Normalise a search term, at indexing and at query time alike: lower-case,
 * drop English stop words, and reduce the word to its Porter stem, so
 * "cats" matches "cat" and "vaccinated" matches "vaccination".
 *
 * @param {String} term - raw term
 * @return {String|null} processed term, or null to drop it
 */
export function processTerm(term: string): string | null {
  const t = term.toLowerCase().replace(/'s$/, "");
  if (STOP_WORDS.has(t)) {
    return null;
  }
  return stemmer(t);
}

/**
 * Split identifiers into words: "listPetVisits" -> "list pet visits".
 *
 * @param {String} s - identifier
 * @return {String} words
 */
export function splitWords(s: string | undefined): string {
  return (s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-/{}.]+/g, " ")
    .toLowerCase();
}

/**
 * Convert a record to an indexable document.
 *
 * @private
 */
function _doc(r: MethodRecord): Record<string, string> {
  return {
    id: r.id,
    methodName: r.methodName,
    methodWords: splitWords(r.methodName),
    className: `${r.className} ${splitWords(r.className.replace(/Api$/, ""))}`,
    operationId: `${r.operationId ?? ""} ${splitWords(r.operationId)}`,
    summary: r.summary ?? "",
    description: r.description ?? "",
    tags: r.tags.join(" "),
    path: `${r.httpMethod} ${splitWords(r.path)}`,
    params: [
      ...r.apiParameters.map(
        // The schema type carries enum values, e.g. "dog" | "cat".
        (p) =>
          `${p.name} ${splitWords(p.name)} ${p.description ?? ""} ${p.schemaType ?? ""}`,
      ),
      ...r.parameters.map((p) => p.name),
    ].join(" "),
    types: [
      r.returnType,
      ...r.referencedTypes.map(
        (t) =>
          `${t.name} ${t.declaration.replace(/[{}();:|"'<>[\],=?]/g, " ")}`,
      ),
    ].join(" "),
  };
}

/** A compact search hit. */
export interface SearchHit {
  id: string;
  sdkPath: string;
  signature: string;
  summary?: string;
  httpMethod: string;
  path: string;
  requiredArguments: string[];
  auth: string;
  score: number;
}

/**
 * Summarise auth requirements in one line.
 *
 * @param {Object} r - method record
 * @return {String} summary
 */
export function authLine(r: MethodRecord): string {
  if (r.auth.alternatives.length === 0) {
    return "none";
  }
  const alts = r.auth.alternatives
    .map((a) => a.schemes.map((s) => `${s.name}(${s.type})`).join(" + "))
    .join(" OR ");
  return `${alts}${r.auth.optional ? " OR none" : ""}${
    r.auth.unsupportedSchemes.length
      ? ` [unsupported: ${r.auth.unsupportedSchemes.join(", ")}]`
      : ""
  }`;
}

/**
 * Search index over method records.
 */
export class MethodSearchIndex {
  private readonly mini: MiniSearch;
  private readonly byId: Map<string, MethodRecord>;

  /**
   * @param {Array} records - method records
   * @param {String} [serialised] - previously serialised MiniSearch JSON
   */
  constructor(
    readonly records: MethodRecord[],
    serialised?: string,
  ) {
    this.byId = new Map(records.map((r) => [r.id, r]));
    const options = {
      fields: FIELDS,
      storeFields: ["id"],
      processTerm,
      searchOptions: SEARCH_OPTIONS,
    };
    if (serialised) {
      this.mini = MiniSearch.loadJSON(serialised, options);
    } else {
      this.mini = new MiniSearch(options);
      this.mini.addAll(records.map(_doc));
    }
  }

  /**
   * Serialise the full-text index.
   *
   * @return {String} JSON
   */
  serialise(): string {
    return JSON.stringify(this.mini);
  }

  /**
   * Look up a record by id.
   *
   * @param {String} id - "<Class>.<method>"
   * @return {Object|undefined} record
   */
  get(id: string): MethodRecord | undefined {
    return this.byId.get(id);
  }

  /**
   * Ranked search restricted to visible records.
   *
   * @param {String} query - free text
   * @param {Object} opts - options
   * @param {Function} opts.visible - filter for records the caller may use
   * @param {Number} opts.limit - maximum results
   * @param {String} [opts.tag] - restrict to a tag or API class
   * @return {Object} { hits, total }
   */
  search(
    query: string,
    opts: {
      visible: (r: MethodRecord) => boolean;
      limit: number;
      tag?: string;
    },
  ): { hits: SearchHit[]; total: number } {
    const results = this.mini.search(query);
    const hits: SearchHit[] = [];
    let total = 0;
    for (const res of results) {
      const r = this.byId.get(String(res.id));
      if (!r || !opts.visible(r)) {
        continue;
      }
      if (opts.tag && !r.tags.includes(opts.tag) && r.className !== opts.tag) {
        continue;
      }
      total++;
      if (hits.length < opts.limit) {
        hits.push({
          id: r.id,
          sdkPath: r.sdkPath,
          signature: r.signature,
          summary: r.summary ?? r.description?.split("\n")[0],
          httpMethod: r.httpMethod,
          path: r.path,
          requiredArguments: r.requiredArguments,
          auth: authLine(r),
          score: Math.round(res.score * 100) / 100,
        });
      }
    }
    return { hits, total };
  }

  /**
   * Overview of capabilities grouped by API class, for agents that do not
   * yet know the API's vocabulary.
   *
   * @param {Object} opts - options
   * @param {Function} opts.visible - filter for records the caller may use
   * @param {Number} opts.perClass - method names listed per class
   * @param {String} [opts.tag] - restrict to a tag or API class (lists all)
   * @return {Array} groups
   */
  browse(opts: {
    visible: (r: MethodRecord) => boolean;
    perClass: number;
    tag?: string;
  }): Array<{
    api: string;
    tags: string[];
    methodCount: number;
    methods: Array<{ id: string; summary?: string }>;
    more: number;
  }> {
    const groups = new Map<string, MethodRecord[]>();
    for (const r of this.records) {
      if (!opts.visible(r)) {
        continue;
      }
      if (opts.tag && !r.tags.includes(opts.tag) && r.className !== opts.tag) {
        continue;
      }
      groups.set(r.className, [...(groups.get(r.className) ?? []), r]);
    }
    const limit = opts.tag ? 100 : opts.perClass;
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([api, rs]) => ({
        api,
        tags: [...new Set(rs.flatMap((r) => r.tags))],
        methodCount: rs.length,
        methods: rs
          .slice(0, limit)
          .map((r) => ({ id: r.id, summary: r.summary })),
        more: Math.max(0, rs.length - limit),
      }));
  }
}
