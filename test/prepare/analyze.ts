"use strict";
import fs from "node:fs";
import path from "node:path";

import referee from "@sinonjs/referee";

import {
  SdkAnalyzer,
  normaliseName,
  scanImplementation,
} from "../../lib/prepare/analyze.js";
import type { AnalyzedMethod } from "../../lib/prepare/analyze.js";
import { emitDeclarations } from "../../lib/prepare/bundle.js";
import { inspectSdk } from "../../lib/prepare/compat.js";
import {
  buildRecords,
  hintsForOperation,
  normalisePathTemplate,
  summariseAuth,
} from "../../lib/prepare/method-records.js";
import { loadSpec } from "../../lib/prepare/spec.js";
import { OagMcpError } from "../../lib/errors.js";
import type { MethodRecord, SpecSummary } from "../../lib/types.js";
import {
  SDK_726,
  SDK_VARIANT,
  SPEC,
  copyFixture,
  tmpDir,
} from "../helpers/paths.js";

const { assert } = referee;

async function analyse(sdkDir: string, spec: SpecSummary) {
  const insp = inspectSdk(sdkDir);
  const types = path.join(tmpDir(), "types");
  emitDeclarations(insp.entry, types);
  const impl = scanImplementation(insp.apiFiles);
  const byKey = new Map(spec.operations.map((o) => [o.key, o]));
  const methods = new SdkAnalyzer(path.join(types, "index.d.ts")).analyze(
    impl,
    (m, p) => hintsForOperation(byKey.get(`${m} ${p}`)),
  );
  return { impl, methods };
}

function writeImpl(name: string, text: string): string {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, text);
  return file;
}

const SYNTHETIC_DTS = `export declare class BaseAPI {}
/** The base. */
export interface Base { id: number; }
export interface Big extends Base {
  [key: string]: unknown;
${Array.from({ length: 41 }, (_, i) => `  /** Member ${i}. */\n  m${i}: string;`).join("\n")}
}
export declare enum Color { Red = "red", Blue = "blue" }
export type Shape = { kind: string } | null;
export type Size = "s" | "m";
export type Nothing = null | undefined;
export interface Deep { x: number; }
export interface Inner { deep: Deep; }
export interface Nested { inner: Inner; }
export interface ThingRequest {
  color: Color; size: Size; when: Date; tags: Array<string>; flag: boolean;
  nested: Nested; shape: Shape; record: Record<"a", number>; nothing: Nothing;
  opts: { a?: string }; count: number; label: string; later?: string;
}
export declare class ThingsApi extends BaseAPI {
  constructor();
  basePath: string;
  private hidden(): Promise<void>;
  protected prot(): Promise<void>;
  static make(): ThingsApi;
  getThingRaw(): Promise<void>;
  getThingRequestOpts(): Promise<void>;
  /**
   * Get a thing.
   * @deprecated
   */
  getThing(requestParameters: ThingRequest, initOverrides?: unknown): Promise<Big>;
  getRecord(requestParameters: Record<"a", Nested>): Promise<void>;
  untyped();
  listThings(a: number, body: Nested, mode: "x" | "y", b?: string): Promise<void>;
  inline(requestParameters: { id: number }): Promise<void>;
  noArgs(): Promise<Shape>;
}
export declare class OtherApi extends BaseAPI {
  orphan(): Promise<void>;
}
`;

function syntheticAnalyzer(): SdkAnalyzer {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "index.d.ts"), SYNTHETIC_DTS);
  return new SdkAnalyzer(path.join(dir, "index.d.ts"));
}

function binding(p: string) {
  return { httpMethod: "GET", path: p, source: "RequestOpts" as const };
}

const THINGS_BINDINGS = new Map([
  ["getThing", binding("/t")],
  ["getRecord", binding("/r")],
  ["untyped", binding("/u")],
  ["listThings", binding("/l")],
  ["noArgs", binding("/n")],
  ["inline", binding("/i")],
]);

const THINGS_HINTS: Record<string, Record<string, unknown>> = {
  "/t": {
    color: "blue",
    size: "m",
    when: "2026-02-02",
    tags: ["x"],
    flag: false,
    count: 3,
    __body: { inner: { deep: { x: 9 } } },
  },
  "/r": { __body: { inner: {} } },
  "/l": { a: 5, __body: { inner: { deep: { x: 2 } } } },
};

describe("analyze - scanImplementation", function () {
  it("should read HTTP method and path templates from RequestOpts implementations", function () {
    const insp = inspectSdk(SDK_726);
    const impl = scanImplementation(insp.apiFiles);
    assert.equals([...impl.keys()].sort(), [
      "AdminApi",
      "OwnersApi",
      "PetsApi",
      "StoreApi",
    ]);
    assert.equals(impl.get("PetsApi")!.get("listPetVisits"), {
      httpMethod: "GET",
      path: "/pets/{petId}/visits",
      source: "RequestOpts",
    });
    assert.equals(impl.get("AdminApi")!.get("deletePet")!.httpMethod, "DELETE");
  });

  it("should fall back to Raw implementations used by older generator output", function () {
    const dir = tmpDir();
    const file = path.join(dir, "LegacyApi.ts");
    fs.writeFileSync(
      file,
      `import * as runtime from '../runtime';
export class LegacyApi extends runtime.BaseAPI {
  async getThingRaw(requestParameters: any): Promise<any> {
    const response = await this.request({
      path: \`/things/{${"thingId"}}\`.replace(\`{${"thingId"}}\`, encodeURIComponent(String(requestParameters.thingId))),
      method: 'GET',
      headers: {},
    });
    return response;
  }
}`,
    );
    const impl = scanImplementation([file]);
    assert.equals(impl.get("LegacyApi")!.get("getThing"), {
      httpMethod: "GET",
      path: "/things/{thingId}",
      source: "Raw",
    });
  });

  it("should reconstruct template, parenthesised and variable paths", function () {
    const file = writeImpl(
      "ThingsApi.ts",
      `export class ThingsApi extends runtime.BaseAPI {
  async templateRequestOpts() {
    return { path: \`/a/${"$"}{"b"}/c\`, method: "get" };
  }
  async parenRequestOpts() {
    return { "path": ("/paren"), "method": ("POST") };
  }
  async shorthandRequestOpts() {
    const path = "/short";
    const path2 = "/ignored";
    return { path, method: "PUT" };
  }
  async variableRequestOpts() {
    let urlPath = "/first";
    let urlPath = "/second";
    return { path: urlPath, method: "DELETE" };
  }
}`,
    );
    assert.equals(
      Object.fromEntries(scanImplementation([file]).get("ThingsApi")!),
      {
        template: { httpMethod: "GET", path: "/a/b/c", source: "RequestOpts" },
        paren: { httpMethod: "POST", path: "/paren", source: "RequestOpts" },
        shorthand: { httpMethod: "PUT", path: "/short", source: "RequestOpts" },
        variable: {
          httpMethod: "DELETE",
          path: "/first",
          source: "RequestOpts",
        },
      },
    );
  });

  it("should skip methods whose method or path is not a literal", function () {
    const file = writeImpl(
      "ThingsApi.ts",
      `export class ThingsApi extends runtime.BaseAPI {
  async dynamicRequestOpts() {
    return { path: \`/a/${"$"}{id}\`, method: "GET" };
  }
  async unknownVariableRequestOpts() {
    return { path: urlPath, method: "GET" };
  }
  async emptyMethodRequestOpts() {
    return { path: "/x", method: "" };
  }
  async noPathRequestOpts() {
    return { method: "GET" };
  }
  async declaredRequestOpts(): Promise<void>;
  async RequestOpts() {
    return { path: "/x", method: "GET" };
  }
  async helper() {
    return { path: "/x", method: "GET" };
  }
}
export class Unrelated {
  async otherRequestOpts() {
    return { path: "/x", method: "GET" };
  }
}`,
    );
    const impl = scanImplementation([file]);
    assert.equals([...impl.keys()], ["ThingsApi"]);
    assert.equals(impl.get("ThingsApi")!.size, 0);
  });

  it("should prefer RequestOpts over Raw in either order", function () {
    const file = writeImpl(
      "ThingsApi.ts",
      `export class ThingsApi extends runtime.BaseAPI {
  async aRaw() { return this.request({ path: "/raw", method: "GET" }); }
  async aRequestOpts() { return { path: "/opts", method: "GET" }; }
  async bRequestOpts() { return { path: "/opts", method: "GET" }; }
  async bRaw() { return this.request({ path: "/raw", method: "GET" }); }
  async cRaw() { return this.request({ path: "/raw1", method: "GET" }); }
  async cRaw() { return this.request({ path: "/raw2", method: "GET" }); }
}`,
    );
    const methods = scanImplementation([file]).get("ThingsApi")!;
    assert.equals(methods.get("a")!.path, "/opts");
    assert.equals(methods.get("b")!.path, "/opts");
    assert.equals(methods.get("c")!.path, "/raw2");
  });

  it("should read ES5 prototype assignments in compiled JavaScript", function () {
    const file = writeImpl(
      "ThingsApi.js",
      `var ThingsApi = (function (_super) {
  function ThingsApi() {}
  ThingsApi.prototype.getThingRequestOpts = function () {
    return { path: "/things", method: "GET" };
  };
  ThingsApi.prototype.putThingRaw = () => ({ path: "/things", method: "PUT" });
  ThingsApi.prototype.helper = function () {
    return { path: "/x", method: "GET" };
  };
  ThingsApi.prototype.listRequestOpts = "not a function";
  ThingsApi.other.listRequestOpts = function () {
    return { path: "/x", method: "GET" };
  };
  ThingsApi.prototype.oldRequestOpts += function () {};
  return ThingsApi;
})(BaseAPI);`,
    );
    assert.equals(
      Object.fromEntries(scanImplementation([file]).get("ThingsApi")!),
      {
        getThing: { httpMethod: "GET", path: "/things", source: "RequestOpts" },
        putThing: { httpMethod: "PUT", path: "/things", source: "Raw" },
      },
    );
  });
});

describe("analyze - SdkAnalyzer.analyze", function () {
  it("should bind methods whose names differ from operationIds without assuming equality", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const { records } = buildRecords(spec, methods);
    const byId = new Map(records.map((r) => [r.id, r]));
    assert.equals(
      byId.get("PetsApi.listPetVisits")!.operationId,
      "list-pet-visits",
    );
    assert.equals(
      byId.get("StoreApi.getStoreInventory")!.operationId,
      "get-store-inventory",
    );
    assert.isUndefined(byId.get("AdminApi.healthGet")!.operationId);
    assert.equals(byId.get("AdminApi.healthGet")!.path, "/health");
  });

  it("should extract signatures, required arguments, referenced types and examples", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const create = methods.find((m) => m.methodName === "createPet")!;
    assert.match(
      create.signature,
      /^createPet\(requestParameters: CreatePetRequest/,
    );
    assert.equals(create.requestStyle, "object");
    assert.equals(create.requiredArguments, ["newPet"]);
    assert.equals(create.returnType, "Promise<Pet>");
    assert.match(create.inputType!.declaration, /newPet: NewPet/);
    const names = create.referencedTypes.map((t) => t.name);
    assert.contains(names, "Pet");
    assert.contains(names, "Species");
    assert.match(
      create.referencedTypes.find((t) => t.name === "Species")!.declaration,
      /"dog" \| "cat"/,
    );
    assert.match(
      create.example,
      /sdk\.PetsApi\.createPet\(\{ newPet: \{ name: "Biscuit", species: "dog" \} \}\)/,
    );
  });

  it("should describe positional signatures for useSingleRequestParameter=false", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_VARIANT, spec);
    const list = methods.find((m) => m.methodName === "listPets")!;
    assert.equals(list.requestStyle, "positional");
    assert.match(
      list.signature,
      /listPets\(species\?: Species, limit\?: number/,
    );
    const get = methods.find((m) => m.methodName === "getPetById")!;
    assert.equals(get.requiredArguments, ["petId"]);
    assert.match(get.example, /getPetById\(1\)/);
  });

  it("should report ambiguity when a method's HTTP binding cannot be found", async function () {
    const dir = copyFixture(SDK_726);
    const file = path.join(dir, "src", "apis", "StoreApi.ts");
    // Remove the literal path so the binding can no longer be determined.
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(
          "let urlPath = `/store/inventory`;",
          "let urlPath = computePath();",
        ),
    );
    const spec = await loadSpec(SPEC);
    try {
      await analyse(dir, spec);
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_BINDING_AMBIGUOUS");
      assert.match((e as OagMcpError).message, /StoreApi\.getStoreInventory/);
    }
  });
});

describe("analyze - SdkAnalyzer.analyze declarations", function () {
  before(function () {
    this.methods = syntheticAnalyzer().analyze(
      new Map([["ThingsApi", THINGS_BINDINGS]]),
      (_m, p) => THINGS_HINTS[p] ?? {},
    );
    this.byName = (name: string) =>
      (this.methods as AnalyzedMethod[]).find((m) => m.methodName === name)!;
  });

  it("should analyse public API methods only, sorted by name", function () {
    assert.equals(
      (this.methods as AnalyzedMethod[]).map((m) => m.methodName),
      ["getRecord", "getThing", "inline", "listThings", "noArgs", "untyped"],
    );
  });

  it("should build an object example from hints, literals and the body hint", function () {
    const get = this.byName("getThing") as AnalyzedMethod;
    assert.equals(get.requestStyle, "object");
    assert.equals(get.documentation, "Get a thing.");
    assert.isTrue(get.deprecated);
    assert.equals(get.inputType!.name, "ThingRequest");
    assert.equals(
      get.example,
      'const result = await sdk.ThingsApi.getThing({ color: "blue", size: "m", when: new Date("2026-02-02"), tags: ["x"], flag: false, nested: { inner: { deep: undefined } }, shape: { kind: "example" }, record: { a: undefined }, nothing: undefined, opts: {}, count: 3, label: "example" });\nreturn result;',
    );
    assert.equals(get.requiredArguments.length, 12);
    assert.equals(get.parameters[1], {
      name: "initOverrides",
      type: "unknown",
      optional: true,
    });
  });

  it("should render referenced interfaces, enums and aliases without the input type", function () {
    const get = this.byName("getThing") as AnalyzedMethod;
    const decl = new Map(
      get.referencedTypes.map((t) => [t.name, t.declaration]),
    );
    assert.equals(
      [...decl.keys()],
      ["Big", "Color", "Size", "Nested", "Shape", "Nothing", "Inner"],
    );
    const big = decl.get("Big")!.split("\n");
    assert.equals(big[0], "interface Big extends Base {");
    assert.equals(big[1], "  [key: string]: unknown;");
    assert.equals(big[2], "  m0: string; // Member 0.");
    assert.equals(big.at(-2), "  // … 2 more members");
    assert.equals(big.length, 43);
    assert.match(decl.get("Color")!, /^export declare enum Color \{/);
    assert.equals(decl.get("Size"), 'type Size = "s" | "m";');
    assert.equals(decl.get("Shape"), "type Shape = { kind: string } | null;");
  });

  it("should give properties without declarations an undefined example", function () {
    const rec = this.byName("getRecord") as AnalyzedMethod;
    assert.isUndefined(rec.inputType, "Record is not an SDK declaration");
    assert.equals(rec.requiredArguments, ["a"]);
    assert.equals(
      rec.example,
      "await sdk.ThingsApi.getRecord({ a: undefined });\nreturn { done: true };",
    );
  });

  it("should give the body hint to object-typed positional parameters", function () {
    const list = this.byName("listThings") as AnalyzedMethod;
    assert.equals(list.requestStyle, "positional");
    assert.equals(list.requiredArguments, ["a", "body", "mode"]);
    assert.match(
      list.example,
      /listThings\(5, \{ inner: \{ deep: \{ x: 2 \} \} \}, "x"\)/,
    );
    assert.equals(
      list.referencedTypes.map((t) => t.name),
      ["Nested", "Inner", "Deep"],
    );
  });

  it("should leave out the input type of an inline request type", function () {
    const inline = this.byName("inline") as AnalyzedMethod;
    assert.equals(inline.requestStyle, "object");
    assert.isUndefined(inline.inputType);
    assert.match(inline.example, /inline\(\{ id: 1 \}\)/);
  });

  it("should describe methods without arguments or a declared return type", function () {
    const none = this.byName("noArgs") as AnalyzedMethod;
    assert.equals(none.requestStyle, "none");
    assert.equals(none.requiredArguments, []);
    assert.equals(
      none.example,
      "const result = await sdk.ThingsApi.noArgs();\nreturn result;",
    );
    const untyped = this.byName("untyped") as AnalyzedMethod;
    assert.equals(untyped.signature, "untyped()");
    assert.equals(untyped.returnType, "Promise<unknown>");
    assert.equals(untyped.referencedTypes, []);
  });

  it("should report methods without bindings and bindings without classes", function () {
    try {
      syntheticAnalyzer().analyze(
        new Map([
          ["OtherApi", new Map()],
          ["GhostApi", new Map([["get", binding("/g")]])],
        ]),
        () => ({}),
      );
      assert(false, "expected failure");
    } catch (e) {
      const err = e as OagMcpError;
      assert.equals(err.code, "SDK_BINDING_AMBIGUOUS");
      assert.equals(err.details!.problems, [
        "OtherApi.orphan: no HTTP method/path found in its RequestOpts/Raw implementation",
        "GhostApi: implementation found but no matching class in declarations",
      ]);
    }
  });
});

describe("method-records - buildRecords", function () {
  it("should fail when the SDK has methods the spec does not define", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const trimmed = {
      ...spec,
      operations: spec.operations.filter((o) => o.operationId !== "listOwners"),
    };
    try {
      buildRecords(trimmed, methods);
      assert(false, "expected failure");
    } catch (e) {
      assert.equals((e as OagMcpError).code, "SDK_SPEC_MISMATCH");
    }
  });

  it("should report operations without SDK methods as unmapped", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const { unmapped, records } = buildRecords(
      spec,
      methods.filter((m) => m.methodName !== "healthGet"),
    );
    assert.equals(unmapped, [{ key: "GET /health", operationId: undefined }]);
    assert.equals(records.length, 10);
  });

  it("should detect a binding that matches several operations", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const extra = {
      ...spec.operations.find((o) => o.key === "GET /pets/{petId}")!,
    };
    const dup = {
      ...spec,
      operations: [
        ...spec.operations.filter((o) => o.key !== "GET /pets/{petId}"),
        { ...extra, key: "GET /pets/{id}", path: "/pets/{id}" },
        { ...extra, key: "GET /pets/{x}", path: "/pets/{x}" },
      ],
    };
    try {
      buildRecords(dup, methods);
      assert(false, "expected failure");
    } catch (e) {
      assert.match((e as OagMcpError).message, /matches several operations/);
    }
  });

  it("should summarise auth alternatives and optional auth", function () {
    const schemes = {
      a: {
        name: "a",
        type: "apiKey" as const,
        in: "header" as const,
        supported: true,
      },
      c: { name: "c", type: "openIdConnect" as const, supported: false },
    };
    const s = summariseAuth([{ a: [] }, {}], schemes);
    assert.isTrue(s.optional);
    assert.equals(s.alternatives[0].schemes[0].type, "apiKey-header");
    assert.equals(summariseAuth([{ c: [] }], schemes).unsupportedSchemes, [
      "c",
    ]);
    assert.equals(normalisePathTemplate("/a/{b}/c/"), "/a/{}/c");
    assert.equals(normaliseName("Pet_ID"), "petid");
  });

  it("should give every record an id, sdk path and auth summary", async function () {
    const spec = await loadSpec(SPEC);
    const { methods } = await analyse(SDK_726, spec);
    const { records, bindings } = buildRecords(spec, methods);
    for (const r of records as MethodRecord[]) {
      assert.equals(r.sdkPath, `sdk.${r.className}.${r.methodName}`);
      assert.equals(r.id, `${r.className}.${r.methodName}`);
    }
    assert.equals(bindings.length, records.length);
  });
});
