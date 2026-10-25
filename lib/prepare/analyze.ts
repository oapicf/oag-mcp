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
 * @module prepare/analyze
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

/** Class name -> method name -> binding. */
type Bindings = Map<string, Map<string, ImplBinding>>;

/** What a method body scan has found so far. */
interface BindingScan {
  httpMethod?: string;
  pathInit?: ts.Expression;
  variables: Map<string, ts.Expression>;
}

/** A property assignment with a plain or quoted name. */
type NamedAssignment = ts.PropertyAssignment & {
  name: ts.Identifier | ts.StringLiteral;
};

/** A class method with a plain name. */
type NamedMethod = ts.MethodDeclaration & { name: ts.Identifier };

/** The SDK declaration kinds that are rendered for agents. */
type SdkDeclaration =
  ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration;

/** A method parameter as written in the declarations. */
interface Param {
  name: string;
  type: string;
  optional: boolean;
  node: ts.ParameterDeclaration;
}

/** How a method takes its arguments, and an example call's arguments. */
interface RequestArgs {
  requestStyle: AnalyzedMethod["requestStyle"];
  inputType: TypeDeclaration | undefined;
  requiredArguments: string[];
  exampleArgs: string;
}

/** State shared while analysing the classes of every declaration file. */
interface AnalyzeRun {
  impl: Bindings;
  hintsFor: (httpMethod: string, p: string) => ExampleHints;
  found: Set<string>;
  problems: string[];
  methods: AnalyzedMethod[];
}

/** Implementation method suffixes, most authoritative first. */
const BINDING_SOURCES: ReadonlyArray<ImplBinding["source"]> = [
  "RequestOpts",
  "Raw",
];

const HIDDEN_MODIFIERS =
  ts.ModifierFlags.Private |
  ts.ModifierFlags.Protected |
  ts.ModifierFlags.Static;

/** Example renderers for scalar types, by type flag. */
const SCALAR_EXAMPLES: ReadonlyArray<{
  flags: ts.TypeFlags;
  render: (hint: unknown) => string;
}> = [
  {
    flags: ts.TypeFlags.StringLike,
    render: (hint) =>
      JSON.stringify(typeof hint === "string" ? hint : "example"),
  },
  {
    flags: ts.TypeFlags.NumberLike,
    render: (hint) => (typeof hint === "number" ? String(hint) : "1"),
  },
  {
    flags: ts.TypeFlags.BooleanLike,
    render: (hint) => (typeof hint === "boolean" ? String(hint) : "true"),
  },
];

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
    return _templateText(node);
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
 * Reconstruct a template whose substitutions are all literal-ish.
 *
 * @private
 */
function _templateText(node: ts.TemplateExpression): string | undefined {
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

/**
 * Whether a node is a property assignment with a plain or quoted name.
 *
 * @private
 */
function _isNamedAssignment(n: ts.Node): n is NamedAssignment {
  return (
    ts.isPropertyAssignment(n) &&
    (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
  );
}

/**
 * Remember the first initialiser of each local variable.
 *
 * @private
 */
function _noteVariable(n: ts.Node, scan: BindingScan): void {
  if (
    ts.isVariableDeclaration(n) &&
    ts.isIdentifier(n.name) &&
    n.initializer &&
    !scan.variables.has(n.name.text)
  ) {
    scan.variables.set(n.name.text, n.initializer);
  }
}

/**
 * Take the first `method:` and `path:` properties.
 *
 * @private
 */
function _noteProperty(n: ts.Node, scan: BindingScan): void {
  if (!_isNamedAssignment(n)) {
    return;
  }
  if (n.name.text === "method" && scan.httpMethod === undefined) {
    const text = _literalText(n.initializer);
    if (text) {
      scan.httpMethod = text.toUpperCase();
    }
  }
  if (n.name.text === "path" && scan.pathInit === undefined) {
    scan.pathInit = n.initializer;
  }
}

/**
 * Take a shorthand `path` property as the path.
 *
 * @private
 */
function _noteShorthand(n: ts.Node, scan: BindingScan): void {
  if (
    ts.isShorthandPropertyAssignment(n) &&
    n.name.text === "path" &&
    scan.pathInit === undefined
  ) {
    scan.pathInit = n.name;
  }
}

/**
 * The path text, following a variable the path property names.
 *
 * @private
 */
function _pathText(scan: BindingScan): string | undefined {
  const init = scan.pathInit;
  if (!init) {
    return undefined;
  }
  return ts.isIdentifier(init)
    ? _literalText(scan.variables.get(init.text))
    : _literalText(init);
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
  const scan: BindingScan = { variables: new Map() };
  const visit = (n: ts.Node) => {
    _noteVariable(n, scan);
    _noteProperty(n, scan);
    _noteShorthand(n, scan);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { httpMethod: scan.httpMethod, path: _pathText(scan) };
}

/**
 * The public method an implementation method builds the request for.
 *
 * @private
 */
function _bindingTarget(
  name: string,
): { base: string; source: ImplBinding["source"] } | undefined {
  const source = BINDING_SOURCES.find((s) => name.endsWith(s));
  const base = source ? name.slice(0, -source.length) : "";
  return source && base ? { base, source } : undefined;
}

/**
 * Record the binding an implementation method builds, if it builds one.
 *
 * @private
 */
function _recordBinding(
  out: Bindings,
  cls: string,
  name: string,
  body: ts.Node | undefined,
): void {
  const target = _bindingTarget(name);
  if (!body || !target) {
    return;
  }
  const { httpMethod, path: p } = _extractBinding(body);
  if (!httpMethod || !p) {
    return;
  }
  const methods = out.get(cls) ?? new Map<string, ImplBinding>();
  const existing = methods.get(target.base);
  // RequestOpts is authoritative when both are present.
  if (!existing || existing.source === "Raw") {
    methods.set(target.base, { httpMethod, path: p, source: target.source });
  }
  out.set(cls, methods);
}

/**
 * Whether a class extends the generated runtime's BaseAPI.
 *
 * @private
 */
function _extendsBaseApi(n: ts.ClassDeclaration, sf: ts.SourceFile): boolean {
  return (n.heritageClauses ?? []).some((h) =>
    h.types.some((t) => /BaseAPI$/.test(t.expression.getText(sf))),
  );
}

/**
 * Record the bindings of an API class declaration's methods.
 *
 * @private
 */
function _scanClass(n: ts.Node, sf: ts.SourceFile, out: Bindings): void {
  if (!ts.isClassDeclaration(n) || !n.name || !_extendsBaseApi(n, sf)) {
    return;
  }
  const cls = n.name.text;
  out.set(cls, out.get(cls) ?? new Map());
  for (const m of n.members) {
    if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) {
      _recordBinding(out, cls, m.name.text, m.body);
    }
  }
}

/**
 * The class and method an ES5 `Foo.prototype.bar` target names.
 *
 * @private
 */
function _prototypeMember(
  left: ts.Expression,
): { cls: string; name: string } | undefined {
  if (
    ts.isPropertyAccessExpression(left) &&
    ts.isPropertyAccessExpression(left.expression) &&
    left.expression.name.text === "prototype" &&
    ts.isIdentifier(left.expression.expression)
  ) {
    return { cls: left.expression.expression.text, name: left.name.text };
  }
  return undefined;
}

/**
 * Record the binding of an ES5 method assignment:
 * `Foo.prototype.barRequestOpts = function () { ... }`.
 *
 * @private
 */
function _scanPrototypeAssignment(n: ts.Node, out: Bindings): void {
  if (
    !ts.isBinaryExpression(n) ||
    n.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !(ts.isFunctionExpression(n.right) || ts.isArrowFunction(n.right))
  ) {
    return;
  }
  const member = _prototypeMember(n.left);
  if (member) {
    _recordBinding(out, member.cls, member.name, n.right.body);
  }
}

/**
 * Scan implementation files for API classes and method bindings.
 *
 * @param {Array} files - implementation files under apis/
 * @return {Map} className -> methodName -> binding
 */
export function scanImplementation(files: string[]): Bindings {
  const out: Bindings = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ES2022,
      true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const visit = (n: ts.Node) => {
      _scanClass(n, sf, out);
      _scanPrototypeAssignment(n, out);
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
 * Whether a declaration is of a kind rendered for agents.
 *
 * @private
 */
function _isRenderable(d: ts.Declaration): d is SdkDeclaration {
  return (
    ts.isInterfaceDeclaration(d) ||
    ts.isTypeAliasDeclaration(d) ||
    ts.isEnumDeclaration(d)
  );
}

/**
 * Whether a class member is a public, non-implementation API method.
 *
 * @private
 */
function _isApiMethod(m: ts.ClassElement): m is NamedMethod {
  if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name)) {
    return false;
  }
  const name = m.name.text;
  return (
    !(ts.getCombinedModifierFlags(m) & HIDDEN_MODIFIERS) &&
    !BINDING_SOURCES.some((s) => name.endsWith(s))
  );
}

/**
 * Describe a method parameter.
 *
 * @private
 */
function _param(p: ts.ParameterDeclaration, sf: ts.SourceFile): Param {
  return {
    name: p.name.getText(sf),
    type: p.type ? _compact(p.type.getText(sf)) : "any",
    optional: Boolean(p.questionToken || p.initializer),
    node: p,
  };
}

/**
 * Example hints keyed by normalised property name.
 *
 * @private
 */
function _hintsByName(hint: unknown): Map<string, unknown> {
  const h =
    hint && typeof hint === "object" ? (hint as Record<string, unknown>) : {};
  return new Map(Object.entries(h).map(([k, v]) => [normaliseName(k), v]));
}

/**
 * The names of a type's required properties.
 *
 * @private
 */
function _requiredProperties(type: ts.Type): string[] {
  return type
    .getProperties()
    .filter((s) => !(s.flags & ts.SymbolFlags.Optional))
    .map((s) => s.name);
}

/**
 * The type nodes whose SDK declarations a method's documentation shows.
 *
 * @private
 */
function _typeRoots(apiParams: Param[], m: ts.MethodDeclaration): ts.Node[] {
  return [...apiParams.map((p) => p.node.type), m.type].filter(
    (t): t is ts.TypeNode => t !== undefined,
  );
}

/**
 * The example body that calls a method and returns its result.
 *
 * @private
 */
function _exampleBody(call: string, returnType: string): string {
  return /Promise<void>/.test(returnType)
    ? `await ${call};\nreturn { done: true };`
    : `const result = await ${call};\nreturn result;`;
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
   * Whether a file is one of the SDK's declaration files.
   *
   * @private
   */
  private _isSdkFile(fileName: string): boolean {
    return path.resolve(fileName).startsWith(this.typesDir + path.sep);
  }

  /**
   * Whether a declaration belongs to the SDK (not lib, not the runtime
   * module).
   *
   * @private
   */
  private _isSdkDecl(decl: ts.Declaration): boolean {
    const file = decl.getSourceFile().fileName;
    return this._isSdkFile(file) && !/[\\/]runtime\.d\.ts$/.test(file);
  }

  /**
   * Resolve a type reference to SDK declarations.
   *
   * @private
   */
  private _resolveRef(node: ts.TypeReferenceNode): SdkDeclaration[] {
    let sym = this.checker.getSymbolAtLocation(node.typeName);
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      sym = this.checker.getAliasedSymbol(sym);
    }
    return (sym?.declarations ?? []).filter(
      (d): d is SdkDeclaration => _isRenderable(d) && this._isSdkDecl(d),
    );
  }

  /**
   * The documentation comment of the symbol a name refers to.
   *
   * @private
   */
  private _docOf(name: ts.Node | undefined): string {
    const sym = name ? this.checker.getSymbolAtLocation(name) : undefined;
    return ts.displayPartsToString(sym?.getDocumentationComment(this.checker));
  }

  /**
   * The type of a property symbol, when it has a declaration to read it from.
   *
   * @private
   */
  private _propertyType(p: ts.Symbol): ts.Type | undefined {
    const decl = p.valueDeclaration ?? p.declarations?.[0];
    return decl ? this.checker.getTypeOfSymbolAtLocation(p, decl) : undefined;
  }

  /**
   * Whether a type is an object type other than an array.
   *
   * @private
   */
  private _isPlainObject(t: ts.Type | undefined): boolean {
    return (
      t !== undefined &&
      Boolean(t.flags & ts.TypeFlags.Object) &&
      !this.checker.isArrayType(t)
    );
  }

  /**
   * Render an SDK declaration compactly with member documentation.
   *
   * @private
   */
  private _render(decl: SdkDeclaration): TypeDeclaration {
    if (ts.isInterfaceDeclaration(decl)) {
      return this._renderInterface(decl);
    }
    if (ts.isTypeAliasDeclaration(decl)) {
      return this._renderAlias(decl);
    }
    return {
      name: decl.name.text,
      declaration: this.printer
        .printNode(ts.EmitHint.Unspecified, decl, decl.getSourceFile())
        .trim(),
    };
  }

  /**
   * Render an interface, one documented member per line.
   *
   * @private
   */
  private _renderInterface(decl: ts.InterfaceDeclaration): TypeDeclaration {
    const sf = decl.getSourceFile();
    const heritage = decl.heritageClauses
      ? ` ${decl.heritageClauses.map((h) => h.getText(sf)).join(" ")}`
      : "";
    const hidden = decl.members.length - MAX_MEMBERS;
    const lines = [
      `interface ${decl.name.text}${heritage} {`,
      ...decl.members
        .slice(0, MAX_MEMBERS)
        .map((m) => `  ${this._renderMember(m, sf)}`),
      ...(hidden > 0 ? [`  // … ${hidden} more members`] : []),
      "}",
    ];
    return { name: decl.name.text, declaration: lines.join("\n") };
  }

  /**
   * Render an interface member with its documentation as a comment.
   *
   * @private
   */
  private _renderMember(m: ts.TypeElement, sf: ts.SourceFile): string {
    const doc = _compact(this._docOf(m.name));
    const text = _compact(
      this.printer.printNode(ts.EmitHint.Unspecified, m, sf),
    );
    return `${text}${doc ? ` // ${doc.slice(0, 160)}` : ""}`;
  }

  /**
   * Render a type alias, spelling out a union of literals.
   *
   * @private
   */
  private _renderAlias(decl: ts.TypeAliasDeclaration): TypeDeclaration {
    const type = this.checker.getTypeAtLocation(decl.name);
    const body =
      type.isUnion() && type.types.every((t) => t.isLiteral())
        ? type.types.map((t) => this.checker.typeToString(t)).join(" | ")
        : _compact(decl.type.getText(decl.getSourceFile()));
    return {
      name: decl.name.text,
      declaration: `type ${decl.name.text} = ${body};`,
    };
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
            const name = decl.name.text;
            if (!seen.has(name) && out.length < MAX_REFERENCED_TYPES) {
              seen.add(name);
              out.push(this._render(decl));
              next.push(decl);
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
    const fromUnion = type.isUnion()
      ? this._unionExample(type, hint, depth)
      : undefined;
    return (
      fromUnion ??
      SCALAR_EXAMPLES.find((s) => type.flags & s.flags)?.render(hint) ??
      this._structuredExample(type, hint, depth)
    );
  }

  /**
   * Example for a union: the hinted literal, the first literal, or an
   * example of the first non-null member.
   *
   * @private
   */
  private _unionExample(
    type: ts.UnionType,
    hint: unknown,
    depth: number,
  ): string | undefined {
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
      return this.checker.typeToString(literals[0]);
    }
    // Under the SDK program's non-strict checking a union has no null or
    // undefined members; the filter guards a stricter configuration.
    const [first] = nonNull;
    return first && this._example(first, hint, depth);
  }

  /**
   * Example for a date, array or object type.
   *
   * @private
   */
  private _structuredExample(
    type: ts.Type,
    hint: unknown,
    depth: number,
  ): string {
    if (this.checker.typeToString(type) === "Date") {
      return `new Date(${JSON.stringify(typeof hint === "string" ? hint : "2026-01-31")})`;
    }
    if (this.checker.isArrayType(type)) {
      const [elem] = this.checker.getTypeArguments(type as ts.TypeReference);
      const h = Array.isArray(hint) ? hint[0] : undefined;
      return elem ? `[${this._example(elem, h, depth + 1)}]` : "[]";
    }
    if (type.flags & ts.TypeFlags.Object && depth < 3) {
      return this._objectExample(type, hint, depth);
    }
    return "undefined";
  }

  /**
   * Example object literal with the type's required properties.
   *
   * @private
   */
  private _objectExample(type: ts.Type, hint: unknown, depth: number): string {
    const props = type
      .getProperties()
      .filter((p) => !(p.flags & ts.SymbolFlags.Optional));
    if (props.length === 0) {
      return "{}";
    }
    const hintByName = _hintsByName(hint);
    const parts = props.slice(0, 12).map((p) => {
      const pt = this._propertyType(p) ?? this.checker.getAnyType();
      return `${p.name}: ${this._example(pt, hintByName.get(normaliseName(p.name)), depth + 1)}`;
    });
    return `{ ${parts.join(", ")} }`;
  }

  /**
   * Analyse every public method of every API class.
   *
   * @param {Map} impl - implementation bindings from {@link scanImplementation}
   * @param {Function} hintsFor - returns example hints for (method, path)
   * @return {Array} analysed methods
   */
  analyze(
    impl: Bindings,
    hintsFor: (httpMethod: string, p: string) => ExampleHints,
  ): AnalyzedMethod[] {
    const run: AnalyzeRun = {
      impl,
      hintsFor,
      found: new Set(),
      problems: [],
      methods: [],
    };
    for (const sf of this.program.getSourceFiles()) {
      if (this._isSdkFile(sf.fileName)) {
        ts.forEachChild(sf, (node) => this._analyzeClass(sf, node, run));
      }
    }
    for (const cls of impl.keys()) {
      if (!run.found.has(cls)) {
        run.problems.push(
          `${cls}: implementation found but no matching class in declarations`,
        );
      }
    }
    if (run.problems.length > 0) {
      throw new OagMcpError(
        "SDK_BINDING_AMBIGUOUS",
        `Could not reliably map SDK methods to HTTP operations: ${run.problems.slice(0, 5).join("; ")}`,
        {
          hint: "The SDK may have been modified after generation, or generated by an unsupported version. Regenerate it with a supported OpenAPI Generator version.",
          details: { problems: run.problems },
        },
      );
    }
    return run.methods.sort((a, b) =>
      `${a.className}.${a.methodName}`.localeCompare(
        `${b.className}.${b.methodName}`,
      ),
    );
  }

  /**
   * Analyse the public methods of a declared class that has bindings.
   *
   * @private
   */
  private _analyzeClass(sf: ts.SourceFile, node: ts.Node, run: AnalyzeRun) {
    if (!ts.isClassDeclaration(node) || !node.name) {
      return;
    }
    const cls = node.name.text;
    const bindings = run.impl.get(cls);
    if (!bindings) {
      return;
    }
    run.found.add(cls);
    for (const m of node.members.filter(_isApiMethod)) {
      const binding = bindings.get(m.name.text);
      if (binding) {
        run.methods.push(
          this._method(
            sf,
            cls,
            m,
            binding,
            run.hintsFor(binding.httpMethod, binding.path),
          ),
        );
      } else {
        run.problems.push(
          `${cls}.${m.name.text}: no HTTP method/path found in its RequestOpts/Raw implementation`,
        );
      }
    }
  }

  /**
   * Analyse a single method declaration.
   *
   * @private
   */
  private _method(
    sf: ts.SourceFile,
    cls: string,
    m: NamedMethod,
    binding: ImplBinding,
    hints: ExampleHints,
  ): AnalyzedMethod {
    const name = m.name.text;
    const params = m.parameters.map((p) => _param(p, sf));
    const apiParams = params.filter((p) => p.name !== "initOverrides");
    const returnType = m.type
      ? _compact(m.type.getText(sf))
      : "Promise<unknown>";
    const args = this._requestArgs(apiParams, hints);
    const referencedTypes = this._collectTypes(_typeRoots(apiParams, m));
    return {
      className: cls,
      methodName: name,
      httpMethod: binding.httpMethod,
      path: binding.path,
      signature: _compact(
        this.printer.printNode(ts.EmitHint.Unspecified, m, sf),
      ).replace(/;$/, ""),
      parameters: params.map(({ name: n, type, optional }) => ({
        name: n,
        type,
        optional,
      })),
      requestStyle: args.requestStyle,
      inputType: args.inputType,
      returnType,
      referencedTypes: referencedTypes.filter(
        (t) => t.name !== args.inputType?.name,
      ),
      requiredArguments: args.requiredArguments,
      documentation: this._docOf(m.name).trim(),
      deprecated: ts
        .getJSDocTags(m)
        .some((t) => t.tagName.text === "deprecated"),
      example: _exampleBody(
        `sdk.${cls}.${name}(${args.exampleArgs})`,
        returnType,
      ),
    };
  }

  /**
   * How a method takes its arguments: one request object, positional
   * arguments, or none.
   *
   * @private
   */
  private _requestArgs(apiParams: Param[], hints: ExampleHints): RequestArgs {
    if (apiParams.length === 1 && apiParams[0].name === "requestParameters") {
      return this._objectArgs(apiParams[0], hints);
    }
    if (apiParams.length > 0) {
      return this._positionalArgs(apiParams, hints);
    }
    return {
      requestStyle: "none",
      inputType: undefined,
      requiredArguments: [],
      exampleArgs: "",
    };
  }

  /**
   * Arguments of a method taking a single request object.
   *
   * @private
   */
  private _objectArgs(p: Param, hints: ExampleHints): RequestArgs {
    const type = this.checker.getNonNullableType(
      this.checker.getTypeAtLocation(p.node),
    );
    const ref =
      p.node.type && ts.isTypeReferenceNode(p.node.type)
        ? this._resolveRef(p.node.type)[0]
        : undefined;
    return {
      requestStyle: "object",
      inputType: ref ? this._render(ref) : undefined,
      requiredArguments: _requiredProperties(type),
      exampleArgs: this._example(type, this._hintObject(type, hints), 0),
    };
  }

  /**
   * Arguments of a method taking positional parameters.
   *
   * @private
   */
  private _positionalArgs(
    apiParams: Param[],
    hints: ExampleHints,
  ): RequestArgs {
    const required = apiParams.filter((p) => !p.optional);
    return {
      requestStyle: "positional",
      inputType: undefined,
      requiredArguments: required.map((p) => p.name),
      exampleArgs: required
        .map((p) => {
          const t = this.checker.getTypeAtLocation(p.node);
          const hint =
            hints[normaliseName(p.name)] ??
            (this._isPlainObject(t) ? hints.__body : undefined);
          return this._example(t, hint, 0);
        })
        .join(", "),
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
      } else if (
        hints.__body !== undefined &&
        // The body parameter is usually the only object-typed property.
        this._isPlainObject(this._propertyType(p))
      ) {
        out[p.name] = hints.__body;
      }
    }
    return out;
  }
}
