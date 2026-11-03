# 9. TypeScript and the Olympia build, from the generator-node template

Status: accepted

## Context

The repository started from the `generator-node` CLI template: JavaScript,
Mocha, bagofcli, and the Suntory and Bob build tooling. OAG-MCP builds on
promise-based TypeScript tools (the MCP SDK, fetch, esbuild, the TypeScript
compiler API), and works with typed structures throughout.

## Decision

The project is TypeScript, built with Olympia, a TypeScript counterpart of
Suntory. Changes from the template:

- **Build**: the Makefile is Olympia's, and Bob is not used. Its targets run
  the project's own tools directly: `tsc` (`build`, `typecheck`), Prettier
  (`style`), ESLint (`lint`, and `complexity` through its `complexity` rule),
  Mocha and c8 (`test`, `test-integration`, `coverage`), TypeDoc (`doc`) and
  `npm pack` (`package`). The only npm script is the `prepare` lifecycle
  hook, which builds `dist/` on `npm install` and before `npm pack` and
  `npm publish`.
- **Language**: sources are TypeScript in `lib/`, compiled by `tsc` to
  `dist/`; `bin/oag-mcp.js` loads `dist/cli.js`.
- **Conventions**: ES modules, `"use strict"`, JSDoc and `module - method`
  test naming are kept from the template. Callbacks are replaced by
  `async`/`await`.
- **CLI**: still bagofcli with `conf/commands.json`; the template's sample
  command and model were removed.
- **Tests**: Mocha, Sinon and referee are kept, in TypeScript run through
  `tsx`. Integration tests add a mock API and a local authorization server,
  and `test-integration/cli.ts` runs the CLI as a process.
- **Lint and format**: ESLint with `typescript-eslint`; Prettier.
- **Extras**: `Makefile-extras` adds `gen-sdk` (generate and pack an SDK) and
  `test-ocsf` (validate audit records against the OCSF schema).

## Consequences

- The build, lint, test and release targets are the same as in other
  projects built with Olympia, and tool versions come from `package.json`
  and its lock file.
- The Makefile is managed by Olympia and must not be edited in this
  repository; project-specific targets go in `Makefile-extras`.
