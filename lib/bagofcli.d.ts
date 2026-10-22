// Minimal type declarations for bagofcli (JavaScript-only package).
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
