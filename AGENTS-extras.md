# AGENTS-extras.md

Project-specific conventions for oag-mcp, in addition to [AGENTS.md](AGENTS.md).
AGENTS.md is refreshed from the shared generator-node template by
`make update-dotfiles`; this file is not, so keep oag-mcp-only guidance here.

## Where types live

TypeScript types are placed by what kind of type they are, not by where they
happen to be used first:

| Kind of type | Location | Examples |
| --- | --- | --- |
| A replaceable contract: an interface meant to have other implementations, with the types of its inputs and outputs | `lib/<module>/types.ts` | `Executor`, `ExecutionRequest` in `lib/executor/types.ts`; `CredentialProvider`, `CredentialContext` in `lib/upstream/types.ts` |
| Data shared between stages or modules | `lib/types.ts` | `MethodRecord`, `OperationBinding`, `PreparedSdkInfo`, `Principal` |
| A function's own options and result | next to the function | `PrepareOptions`, `ServeOptions`, `RunningServer` |
| Types derived from a zod schema (`z.infer`) | next to the schema | `RuntimeConfig`, `AuthorizationRule` |
| Types used inside one module only | in that file | `ResolvedSecurity`, `DenoRuntime` |

Guidelines:

- `types.ts` files are type-only: interfaces and type aliases, no classes,
  functions or values. Runtime code such as an error class stays with its
  implementation (e.g. `UpstreamAuthError` in `lib/upstream/credentials.ts`).
- Implementations live next to their code, not in `types.ts`, and declare
  the contract they fulfil: `class DenoExecutor implements Executor`,
  `class ServiceIdentityCredentialProvider implements CredentialProvider`.
- Callers depend on the contract, not the implementation: import
  `Executor` from `lib/executor/types.ts`, never from `deno-executor.ts`.
- Dependencies point one way: a module's `types.ts` may import from
  `lib/types.ts`, but `lib/types.ts` never imports from a module.
- Public contracts are re-exported from `lib/index.ts` for programmatic users.
