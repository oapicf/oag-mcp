"use strict";
/**
 * Static analysis of a typescript-fetch SDK.
 *
 * Two independent sources are combined:
 *
 * 1. Implementation files (TypeScript sources or compiled JavaScript) are
 *    parsed to find, for every public API method, the HTTP method and path
 *    template it sends. typescript-fetch 7.x builds these in
 *    `<method>RequestOpts`; older output builds them in `<method>Raw`. This
 *    gives a reliable binding without assuming operationId equals the
 *    generated method name.
 * 2. Declarations (`.d.ts`) are type-checked to extract exact signatures,
 *    documentation and the declarations of referenced types.
 *
 * @module build/analyze
 */
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { OagMcpError } from "../errors.js";
import type { TypeDeclaration } from "../types.js";
import { sdkCompilerOptions } from "./bundle.js";

/** HTTP binding found in an implementation method. */
export interface ImplBinding {
  httpMethod: string;
  path: string;
  source: "RequestOpts" | "Raw";
}

/** A public API method of the SDK with its binding and types. */
export interface AnalyzedMethod {
  className: string;
  methodName: string;
  httpMethod: string;
  path: string;
  signature: string;
  parameters: Array<{ name: string; type: string; optional: boolean }>;
  requestStyle: "object" | "positional" | "none";
  inputType?: TypeDeclaration;
  returnType: string;
  referencedTypes: TypeDeclaration[];
  requiredArguments: string[];
  documentation: string;
  deprecated: boolean;
  example: string;
}

/** Example hints keyed by normalised parameter/property name. */
export type ExampleHints = Record<string, unknown>;

const MAX_REFERENCED_TYPES = 15;
const MAX_TYPE_DEPTH = 3;
const MAX_MEMBERS = 40;

/**
 * Normalise a name for loose matching between OpenAPI and SDK naming.
 *
 * @param {String} name - name
 * @return {String} normalised name
 */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reconstruct a string from a literal-ish expression.
 *
 * @private
 */
function _literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const inner = _literalText(span.expression);
      if (inner === undefined) {
        return undefined;
      }
      out += inner + span.literal.text;
    }
    return out;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    // `/pets/{petId}`.replace(...) in older generator output
    return _literalText(node.expression.expression);
  }
  if (ts.isParenthesizedExpression(node)) {
    return _literalText(node.expression);
  }
  return undefined;
}

/**
 * Find the HTTP method and path built inside a method body.
 *
 * @private
 */
function _extractBinding(body: ts.Node): {
  httpMethod?: string;
  path?: string;
} {
  let httpMethod: string | undefined;
  let pathInit: ts.Expression | undefined;
  const variables = new Map<string, ts.Expression>();
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer
    ) {
      if (!variables.has(n.name.text)) {
        variables.set(n.name.text, n.initializer);
      }
    }
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
    ) {
      const key = n.name.text;
      if (key === "method" && httpMethod === undefined) {
        const t = _literalText(n.initializer);
        if (t) {
          httpMethod = t.toUpperCase();
        }
      }
      if (key === "path" && pathInit === undefined) {
        pathInit = n.initializer;
      }
    }
    if (
      ts.isShorthandPropertyAssignment(n) &&
      n.name.text === "path" &&
      pathInit === undefined
    ) {
      pathInit = n.name;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  let p: string | undefined;
  if (pathInit) {
    p = ts.isIdentifier(pathInit)
      ? _literalText(variables.get(pathInit.text))
      : _literalText(pathInit);
  }
  return { httpMethod, path: p };
}

/**
 * Scan implementation files for API classes and method bindings.
 *
 * @param {Array} files - implementation files under apis/
 * @return {Map} className -> methodName -> binding
 */
export function scanImplementation(
  files: string[],
): Map<string, Map<string, ImplBinding>> {
  const out = new Map<string, Map<string, ImplBinding>>();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ES2022,
      true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const record = (cls: string, name: string, body: ts.Node | undefined) => {
      if (!body) {
        return;
      }
      let base: string | undefined;
      let source: ImplBinding["source"] | undefined;
      if (name.endsWith("RequestOpts")) {
        base = name.slice(0, -"RequestOpts".length);
        source = "RequestOpts";
      } else if (name.endsWith("Raw")) {
        base = name.slice(0, -"Raw".length);
        source = "Raw";
      }
      if (!base || !source) {
        return;
      }
      const { httpMethod, path: p } = _extractBinding(body);
      if (!httpMethod || !p) {
        return;
      }
      const methods = out.get(cls) ?? new Map<string, ImplBinding>();
      const existing = methods.get(base);
      // RequestOpts is authoritative when both are present.
      if (!existing || existing.source === "Raw") {
        methods.set(base, { httpMethod, path: p, source });
      }
      out.set(cls, methods);
    };
    const visit = (n: ts.Node) => {
      if (ts.isClassDeclaration(n) && n.name) {
        const extendsBase = (n.heritageClauses ?? []).some((h) =>
          h.types.some((t) => /BaseAPI$/.test(t.expression.getText(sf))),
        );
        if (extendsBase) {
          out.set(n.name.text, out.get(n.name.text) ?? new Map());
          for (const m of n.members) {
            if (
              ts.isMethodDeclaration(m) &&
              m.name &&
              ts.isIdentifier(m.name)
            ) {
              record(n.name.text, m.name.text, m.body);
            }
          }
        }
      }
      // ES5 output: Foo.prototype.barRequestOpts = function () { ... }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(n.left) &&
        ts.isPropertyAccessExpression(n.left.expression) &&
        n.left.expression.name.text === "prototype" &&
        ts.isIdentifier(n.left.expression.expression) &&
        (ts.isFunctionExpression(n.right) || ts.isArrowFunction(n.right))
      ) {
        record(
          n.left.expression.expression.text,
          n.left.name.text,
          n.right.body,
        );
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Collapse whitespace in a declaration snippet.
 *
 * @private
 */
function _compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Analyse SDK declarations together with implementation bindings.
 */
export class SdkAnalyzer {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly typesDir: string;
  private readonly printer = ts.createPrinter({ removeComments: true });

  /**
   * @param {String} typesIndex - path to the SDK declarations index.d.ts
   */
  constructor(typesIndex: string) {
    this.typesDir = path.dirname(path.resolve(typesIndex));
    this.program = ts.createProgram([typesIndex], {
      ...sdkCompilerOptions(),
      noEmit: true,
    });
    this.checker = this.program.getTypeChecker();
  }

  /**
   * Whether a declaration belongs to the SDK (not lib, not the runtime
   * module).
   *
   * @private
   */
  private _isSdkDecl(decl: ts.Declaration): boolean {
    const file = path.resolve(decl.getSourceFile().fileName);
    return (
      file.startsWith(this.typesDir + path.sep) &&
      !/[\\/]runtime\.d\.ts$/.test(file)
    );
  }

  /**
   * Resolve a type reference to SDK declarations.
   *
   * @private
   */
  private _resolveRef(node: ts.TypeReferenceNode): ts.Declaration[] {
    let sym = this.checker.getSymbolAtLocation(node.typeName);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      sym = this.checker.getAliasedSymbol(sym);
    }
    return (sym?.declarations ?? []).filter(
      (d) =>
        (ts.isInterfaceDeclaration(d) ||
          ts.isTypeAliasDeclaration(d) ||
          ts.isEnumDeclaration(d)) &&
        this._isSdkDecl(d),
    );
  }

  /**
   * Render an SDK declaration compactly with member documentation.
   *
   * @private
   */
  private _render(decl: ts.Declaration): TypeDeclaration | undefined {
    const sf = decl.getSourceFile();
    if (ts.isInterfaceDeclaration(decl)) {
      const lines: string[] = [];
      const heritage = decl.heritageClauses
        ? ` ${decl.heritageClauses.map((h) => h.getText(sf)).join(" ")}`
        : "";
      lines.push(`interface ${decl.name.text}${heritage} {`);
      decl.members.slice(0, MAX_MEMBERS).forEach((m) => {
        const sym = m.name
          ? this.checker.getSymbolAtLocation(m.name)
          : undefined;
        const doc = sym
          ? _compact(
              ts.displayPartsToString(
                sym.getDocumentationComment(this.checker),
              ),
            )
          : "";
        const text = _compact(
          this.printer.printNode(ts.EmitHint.Unspecified, m, sf),
        );
        lines.push(`  ${text}${doc ? ` // ${doc.slice(0, 160)}` : ""}`);
      });
      if (decl.members.length > MAX_MEMBERS) {
        lines.push(`  // … ${decl.members.length - MAX_MEMBERS} more members`);
      }
      lines.push("}");
      return { name: decl.name.text, declaration: lines.join("\n") };
    }
    if (ts.isTypeAliasDeclaration(decl)) {
      const type = this.checker.getTypeAtLocation(decl.name);
      let body: string;
      if (type.isUnion() && type.types.every((t) => t.isLiteral())) {
        body = type.types.map((t) => this.checker.typeToString(t)).join(" | ");
      } else {
        body = _compact(decl.type.getText(sf));
      }
      return {
        name: decl.name.text,
        declaration: `type ${decl.name.text} = ${body};`,
      };
    }
    if (ts.isEnumDeclaration(decl)) {
      return {
        name: decl.name.text,
        declaration: this.printer
          .printNode(ts.EmitHint.Unspecified, decl, sf)
          .trim(),
      };
    }
    return undefined;
  }

  /**
   * Collect SDK declarations referenced from type nodes, breadth first.
   *
   * @private
   */
  private _collectTypes(roots: ts.Node[]): TypeDeclaration[] {
    const out: TypeDeclaration[] = [];
    const seen = new Set<string>();
    let frontier: ts.Node[] = roots;
    for (
      let depth = 0;
      depth < MAX_TYPE_DEPTH && frontier.length > 0;
      depth++
    ) {
      const next: ts.Node[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isTypeReferenceNode(n)) {
          for (const decl of this._resolveRef(n)) {
            const name = (decl as ts.InterfaceDeclaration).name.text;
            if (!seen.has(name) && out.length < MAX_REFERENCED_TYPES) {
              seen.add(name);
              const rendered = this._render(decl);
              if (rendered) {
                out.push(rendered);
                next.push(decl);
              }
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      frontier.forEach(visit);
      frontier = next;
    }
    return out;
  }

  /**
   * Produce an example expression for a type.
   *
   * @private
   */
  private _example(type: ts.Type, hint: unknown, depth: number): string {
    const c = this.checker;
    const str = c.typeToString(type);
    if (type.isUnion()) {
      const nonNull = type.types.filter(
        (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
      );
      const literals = nonNull.filter((t) => t.isLiteral());
      if (
        hint !== undefined &&
        literals.some((t) => (t as ts.LiteralType).value === hint)
      ) {
        return JSON.stringify(hint);
      }
      if (literals.length > 0) {
        return c.typeToString(literals[0]);
      }
      if (nonNull.length > 0) {
        return this._example(nonNull[0], hint, depth);
      }
    }
    if (type.flags & ts.TypeFlags.StringLike) {
      return JSON.stringify(typeof hint === "string" ? hint : "example");
    }
    if (type.flags & ts.TypeFlags.NumberLike) {
      return typeof hint === "number" ? String(hint) : "1";
    }
    if (type.flags & ts.TypeFlags.BooleanLike) {
      return typeof hint === "boolean" ? String(hint) : "true";
    }
    if (str === "Date") {
      return `new Date(${JSON.stringify(typeof hint === "string" ? hint : "2026-01-31")})`;
    }
    if (c.isArrayType(type)) {
      const [elem] = c.getTypeArguments(type as ts.TypeReference);
      const h = Array.isArray(hint) ? hint[0] : undefined;
      return elem ? `[${this._example(elem, h, depth + 1)}]` : "[]";
    }
    if (type.flags & ts.TypeFlags.Object && depth < 3) {
      const props = type
        .getProperties()
        .filter((p) => !(p.flags & ts.SymbolFlags.Optional));
      if (props.length === 0) {
        return "{}";
      }
      const h =
        hint && typeof hint === "object"
          ? (hint as Record<string, unknown>)
          : {};
      const hintByName = new Map(
        Object.entries(h).map(([k, v]) => [normaliseName(k), v]),
      );
      const parts = props.slice(0, 12).map((p) => {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const pt = decl ? c.getTypeOfSymbolAtLocation(p, decl) : c.getAnyType();
        return `${p.name}: ${this._example(pt, hintByName.get(normaliseName(p.name)), depth + 1)}`;
      });
      return `{ ${parts.join(", ")} }`;
    }
    return "undefined";
  }

  /**
   * Analyse every public method of every API class.
   *
   * @param {Map} impl - implementation bindings from {@link scanImplementation}
   * @param {Function} hintsFor - returns example hints for (method, path)
   * @return {Array} analysed methods
   */
  analyze(
    impl: Map<string, Map<string, ImplBinding>>,
    hintsFor: (httpMethod: string, p: string) => ExampleHints,
  ): AnalyzedMethod[] {
    const methods: AnalyzedMethod[] = [];
    const problems: string[] = [];
    const found = new Set<string>();
    for (const sf of this.program.getSourceFiles()) {
      if (!path.resolve(sf.fileName).startsWith(this.typesDir + path.sep)) {
        continue;
      }
      ts.forEachChild(sf, (node) => {
        if (!ts.isClassDeclaration(node) || !node.name) {
          return;
        }
        const cls = node.name.text;
        const bindings = impl.get(cls);
        if (!bindings) {
          return;
        }
        found.add(cls);
        for (const m of node.members) {
          if (
            !ts.isMethodDeclaration(m) ||
            !m.name ||
            !ts.isIdentifier(m.name)
          ) {
            continue;
          }
          const name = m.name.text;
          const mods = ts.getCombinedModifierFlags(m);
          if (
            mods &
              (ts.ModifierFlags.Private |
                ts.ModifierFlags.Protected |
                ts.ModifierFlags.Static) ||
            name.endsWith("Raw") ||
            name.endsWith("RequestOpts")
          ) {
            continue;
          }
          const binding = bindings.get(name);
          if (!binding) {
            problems.push(
              `${cls}.${name}: no HTTP method/path found in its RequestOpts/Raw implementation`,
            );
            continue;
          }
          methods.push(
            this._method(
              sf,
              cls,
              name,
              m,
              binding,
              hintsFor(binding.httpMethod, binding.path),
            ),
          );
        }
      });
    }
    for (const cls of impl.keys()) {
      if (!found.has(cls)) {
        problems.push(
          `${cls}: implementation found but no matching class in declarations`,
        );
      }
    }
    if (problems.length > 0) {
      throw new OagMcpError(
        "SDK_BINDING_AMBIGUOUS",
        `Could not reliably map SDK methods to HTTP operations: ${problems.slice(0, 5).join("; ")}`,
        {
          hint: "The SDK may have been modified after generation, or generated by an unsupported version. Regenerate it with a supported OpenAPI Generator version.",
          details: { problems },
        },
      );
    }
    return methods.sort((a, b) =>
      `${a.className}.${a.methodName}`.localeCompare(
        `${b.className}.${b.methodName}`,
      ),
    );
  }

  /**
   * Analyse a single method declaration.
   *
   * @private
   */
  private _method(
    sf: ts.SourceFile,
    cls: string,
    name: string,
    m: ts.MethodDeclaration,
    binding: ImplBinding,
    hints: ExampleHints,
  ): AnalyzedMethod {
    const c = this.checker;
    const signature = _compact(
      this.printer.printNode(ts.EmitHint.Unspecified, m, sf),
    ).replace(/;$/, "");
    const params = m.parameters.map((p) => ({
      name: p.name.getText(sf),
      type: p.type ? _compact(p.type.getText(sf)) : "any",
      optional: Boolean(p.questionToken || p.initializer),
      node: p,
    }));
    const apiParams = params.filter((p) => p.name !== "initOverrides");
    const sym = c.getSymbolAtLocation(m.name);
    const documentation = sym
      ? ts.displayPartsToString(sym.getDocumentationComment(c)).trim()
      : "";
    const deprecated = ts
      .getJSDocTags(m)
      .some((t) => t.tagName.text === "deprecated");
    const returnType = m.type
      ? _compact(m.type.getText(sf))
      : "Promise<unknown>";
    let requestStyle: AnalyzedMethod["requestStyle"] = "none";
    let inputType: TypeDeclaration | undefined;
    let requiredArguments: string[] = [];
    let exampleArgs = "";
    if (apiParams.length === 1 && apiParams[0].name === "requestParameters") {
      requestStyle = "object";
      const p = apiParams[0];
      const t = c.getTypeAtLocation(p.node);
      const nonNull = c.getNonNullableType(t);
      requiredArguments = nonNull
        .getProperties()
        .filter((s) => !(s.flags & ts.SymbolFlags.Optional))
        .map((s) => s.name);
      if (p.node.type && ts.isTypeReferenceNode(p.node.type)) {
        const decl = this._resolveRef(p.node.type)[0];
        inputType = decl ? this._render(decl) : undefined;
      }
      exampleArgs = this._example(nonNull, this._hintObject(nonNull, hints), 0);
      if (exampleArgs === "{}" && p.optional) {
        exampleArgs = "{}";
      }
    } else if (apiParams.length > 0) {
      requestStyle = "positional";
      requiredArguments = apiParams
        .filter((p) => !p.optional)
        .map((p) => p.name);
      exampleArgs = apiParams
        .filter((p) => !p.optional)
        .map((p) => {
          const t = c.getTypeAtLocation(p.node);
          const isObject =
            Boolean(t.flags & ts.TypeFlags.Object) && !c.isArrayType(t);
          const hint =
            hints[normaliseName(p.name)] ??
            (isObject ? hints.__body : undefined);
          return this._example(t, hint, 0);
        })
        .join(", ");
    }
    const typeRoots: ts.Node[] = [];
    for (const p of apiParams) {
      if (p.node.type) {
        typeRoots.push(p.node.type);
      }
    }
    if (m.type) {
      typeRoots.push(m.type);
    }
    const referencedTypes = this._collectTypes(typeRoots);
    const call = `sdk.${cls}.${name}(${exampleArgs})`;
    const example = /Promise<void>/.test(returnType)
      ? `await ${call};\nreturn { done: true };`
      : `const result = await ${call};\nreturn result;`;
    return {
      className: cls,
      methodName: name,
      httpMethod: binding.httpMethod,
      path: binding.path,
      signature,
      parameters: params.map(({ name: n, type, optional }) => ({
        name: n,
        type,
        optional,
      })),
      requestStyle,
      inputType,
      returnType,
      referencedTypes: inputType
        ? referencedTypes.filter((t) => t.name !== inputType!.name)
        : referencedTypes,
      requiredArguments,
      documentation,
      deprecated,
      example,
    };
  }

  /**
   * Map example hints onto the properties of a request type.
   *
   * @private
   */
  private _hintObject(
    type: ts.Type,
    hints: ExampleHints,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of type.getProperties()) {
      const h = hints[normaliseName(p.name)];
      if (h !== undefined) {
        out[p.name] = h;
      } else if (hints.__body !== undefined) {
        // The body parameter is usually the only object-typed property.
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const pt = decl
          ? this.checker.getTypeOfSymbolAtLocation(p, decl)
          : undefined;
        if (
          pt &&
          pt.flags & ts.TypeFlags.Object &&
          !this.checker.isArrayType(pt)
        ) {
          out[p.name] = hints.__body;
        }
      }
    }
    return out;
  }
}
