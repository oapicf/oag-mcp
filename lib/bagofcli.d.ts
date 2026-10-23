// Minimal type declarations for bagofcli (JavaScript-only package).
//
// NOTE: this file exists only because bagofcli ships no TypeScript
// declarations (and there is no @types/bagofcli), so `import bag from
// "bagofcli"` fails to compile in strict mode. It is compile-time only and
// is not emitted to dist/.
//
// To make it unnecessary, bagofcli should publish its own declarations:
//   1. Generate them from its existing JSDoc, e.g.
//        tsc lib/bagofcli.js --allowJs --declaration --emitDeclarationOnly \
//          --outDir lib
//      (or hand-write lib/bagofcli.d.ts), describing the default export
//      object, including at least command(), exit(), logStepHeading() and
//      logStepItemSuccess() with the signatures declared below.
//   2. Point package.json at it: "types": "./lib/bagofcli.d.ts". If an
//      "exports" map is ever added, include a "types" condition there too.
//   3. Make sure the .d.ts is in the published package (it is today, as
//      bagofcli has no "files" list; keep it if one is added).
// Then release bagofcli, bump the dependency here, and delete this file;
// `npm run typecheck` confirms the published types are picked up.
declare module "bagofcli" {
  interface Bag {
    command(
      base: string,
      actions: {
        commands: Record<
          string,
          {
            action: (
              args: Record<string, unknown> & { args?: string[] },
            ) => void;
          }
        >;
      },
      opts?: { commandFile?: string },
    ): void;
    exit(err?: Error | null, result?: unknown): void;
    logStepHeading(fmt: string, ...args: unknown[]): void;
    logStepItemSuccess(fmt: string, ...args: unknown[]): void;
  }
  const bag: Bag;
  export default bag;
}
