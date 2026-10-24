# AGENTS.md

This repository contains a TypeScript Node.js project following a unified standard for tooling, build automation, and coding conventions. All projects share the same tooling stack and conventions to ensure consistency and maintainability.

The key components of the standard include:

- Build automation (Olympia)
- Project definition and dependency management (npm)
- Language and compilation (TypeScript, `tsc`)
- Code formatting (Prettier)
- Static analysis (ESLint with typescript-eslint)
- Testing (Mocha + Sinon + referee, run through `tsx`)
- Coverage (c8)
- API documentation (TypeDoc)

This document outlines the common conventions that apply across the TypeScript projects. Project-specific conventions live in [AGENTS-extras.md](AGENTS-extras.md).

## Node.js Version & Dependencies

- **Node.js Version**: 22+
- **Dependency Manager**: npm
- **Lock File**: `package-lock.json` (checked in)
- **Dependency Specification**: `package.json`, with exact version pins

### Adding Dependencies

```bash
npm install --save-exact package_name          # Add to runtime deps
npm install --save-dev --save-exact pkg_name   # Add to dev deps
make deps                                      # Install all deps
```

## Project Structure

```text
project/
├── bin/                      # CLI entry points (plain JavaScript)
│   └── <project>.js          # loads the compiled CLI from dist/
├── conf/                     # Configuration files (commands.json, etc.)
├── examples/                 # Example configs and usage
│   └── *.sh
├── lib/                      # TypeScript sources
│   ├── <module>.ts
│   └── <area>/<module>.ts
├── test/                     # Unit tests, mirroring lib/
│   ├── <module>.ts
│   └── ...
├── test-integration/         # Integration tests
│   ├── cli.ts                # CLI help and option validation, run as a process
│   └── helpers/
├── dist/                     # Compiled JavaScript and declarations (generated, not committed)
├── stage/                    # Temporary and generated files (removed by make clean)
│   ├── gh-pages/             # Reports published to GitHub Pages (coverage, complexity, docs)
│   └── package/              # npm package archive
├── .github/                  # GitHub workflows
├── .gitignore                # Git ignore rules
├── .rtk.json                 # RTK configuration
├── avatar.jpg                # Project avatar (80x80 pixels)
├── AGENTS.md                 # Agent instructions (this file)
├── AGENTS-extras.md          # Project-specific agent instructions
├── CHANGELOG.md              # Changelog file following Keep a Changelog format
├── eslint.config.js          # ESLint configuration (typescript-eslint)
├── LICENSE                   # License file
├── Makefile                  # Build automation (Olympia)
├── Makefile-extras           # Additional Makefile targets specific to the project
├── olympia.yml               # Olympia configuration
├── package.json              # npm package definition
├── package-lock.json         # Locked dependencies
├── README.md                 # Project README
├── tsconfig.build.json       # Compiles lib/ to dist/
└── tsconfig.json             # Type-checks sources and tests (no emit)
```

## Build Automation (Olympia)

This TypeScript project uses **Olympia** as a standard build automation tool that unifies the build pipeline across all projects. The Makefile is sourced from the Olympia project and managed via `make update-to-latest` / `make update-to-version`.

Every target runs the project's own tools from `node_modules/.bin` (no separate build executor), so tool versions come from `package.json` and the lock file. The only npm script is the `prepare` lifecycle hook, which builds `dist/` on `npm install` and before `npm pack` / `npm publish`; everything else is a Makefile target.

### Common Commands

```bash
make ci                # Run full CI pipeline
make all               # Alias for ci
make clean             # Remove coverage/, dist/ and stage/
make stage             # Create stage/ and stage/gh-pages/ using mkdir
make build             # Compile lib/ to dist/ using tsc (tsconfig.build.json)
make typecheck         # Type-check sources and tests using tsc --noEmit (tsconfig.json)
make deps              # Install dependencies using npm install (and mdl via apt)
make deps-upgrade      # Upgrade dependencies using npm-check-updates, then npm install
make rmdeps            # Remove node_modules
make style             # Format code using Prettier (rewrites files)
make lint              # Run static analysis using ESLint, and mdl on Markdown
make test              # Run unit tests using Mocha
make test-examples     # Run example shell scripts using bash
make coverage          # Generate unit test coverage reports using c8
make complexity        # Report functions above COMPLEXITY_MAX using ESLint's complexity rule
make doc               # Generate API documentation using TypeDoc
make package           # Build the npm package archive using npm pack
make install           # Link package locally using npm link
make uninstall         # Unlink package using npm unlink
make reinstall         # Uninstall then install
make test-integration  # Run integration tests using Mocha
```

### Release Targets

```bash
make release-major     # Create major release using RTK
make release-minor     # Create minor release using RTK
make release-patch     # Create patch release using RTK
```

### Update Targets

```bash
make update-to-latest  # Update Makefile to latest Olympia tag using curl + GitHub API + jq
make update-to-main    # Update Makefile to Olympia main branch using curl
make update-to-version # Update Makefile to specific Olympia version using curl
make update-dotfiles   # Refresh project dotfiles using generator-node (git clone + plop + cp)
```

## Development Environment

This project is designed to be developed in a consistent environment via Docker image `cliffano/studio`.

You can run the container using: `docker run --rm --workdir /opt/workspace -v /var/run/docker.sock:/var/run/docker.sock -v $PWD:/opt/workspace -i -t cliffano/studio` and then run the build commands inside the container.

Alternatively you can run the Olympia Makefile targets via Docker container entrypoint, e.g. `docker run --rm --workdir /opt/workspace -v /var/run/docker.sock:/var/run/docker.sock -v $PWD:/opt/workspace -i -t cliffano/studio make ci`.

## Code Style and Linting

Applies to: `**/*.ts`, `**/*.js`

- Formatting uses Prettier via `make style`
- Static analysis uses ESLint (with typescript-eslint) via `make lint`

### Style & Formatting

#### Prettier Formatter

All code must pass `prettier` formatting:

```bash
make style  # Via Olympia; rewrites files in place
```

**Guidelines**:

- Use double quotes for strings (Prettier default)
- Don't manually format — `prettier` is authoritative
- Line length: 80 characters max

#### ESLint Static Analysis

All code should have zero ESLint error and warning:

```bash
make lint
```

**Guidelines**:

- Disable rules only when justified: `/* eslint rule-name: 0 */`
- Use specific rule names, not blanket disables when the exemptions are only specific lines
- Attempt to fix warning root causes before disabling

### TypeScript Conventions

#### Compilation

- Sources are TypeScript in `lib/`, compiled by `tsc` to `dist/` with declarations (`tsconfig.build.json`)
- `tsconfig.json` extends the build configuration to type-check `lib/`, `test/` and `test-integration/` without emitting
- `strict` mode is on; avoid `any` and non-null assertions where a type or a check would do
- `bin/<project>.js` stays plain JavaScript and imports the compiled `dist/cli.js`

#### Module System

Use ES modules (`"type": "module"` in `package.json`, `"module": "NodeNext"`):

```ts
"use strict";
import fs from "node:fs";
import path from "node:path";

import pino from "pino";

import { loadConfig } from "./config.js";
import type { Logs } from "./logger.js";
```

- Always include `"use strict";` at the top of every file
- Relative imports use the `.js` extension of the compiled file, even in `.ts` sources (`./config.js`, not `./config` or `./config.ts`)
- Use the `node:` prefix for Node.js built-in modules
- Use `import type` for imports that are only used as types
- Use named imports where possible
- Group imports: built-in Node.js modules first, then third-party, then local

#### Types

- Place types by what kind of type they are (contracts in `<module>/types.ts`, shared data in `lib/types.ts`, options next to their function); see [AGENTS-extras.md](AGENTS-extras.md) for the full rule
- Prefer libraries' own exported types over re-declaring them

#### Classes

Use ES6 classes for object-oriented modules, and declare the contract a class fulfils:

```ts
class MyService implements Service {
  /**
   * Constructor for initialising MyService.
   *
   * @param {Object} [opts] - optional settings
   * @param {String} [opts.configFile] - path to the configuration file
   * @param {Number} [opts.timeout] - request timeout in milliseconds
   */
  constructor(private readonly opts: MyServiceOptions = {}) {}

  /**
   * Execute the main operation.
   *
   * @param {Array} items - list of items to process
   * @return {Promise} processing result
   */
  async execute(items: Item[]): Promise<Result> {
    // implementation
  }
}

export default MyService;
```

#### Asynchronous Code

Use `async`/`await` and promises. The callback convention (`cb(err, result)`) is not used: the platform APIs and libraries these projects build on (fetch, the TypeScript compiler API, esbuild, the MCP SDK) are promise-based.

```ts
async function doSomething(input: string): Promise<Result> {
  if (!input) {
    throw new Error("Input is required");
  }
  return await process(input);
}
```

- Always `await` (or deliberately return) promises; never leave one floating
- Run independent work concurrently with `Promise.all`

#### Naming Conventions

- **Classes**: `PascalCase` (e.g., `DataProcessor`, `ConfigManager`)
- **Interfaces and types**: `PascalCase` (e.g., `ExecutionRequest`)
- **Functions/Methods**: `camelCase` (e.g., `processData`, `_formatOutput`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_BATCH_SIZE`, `DEFAULT_TIMEOUT`)
- **Private/Internal**: Prefix with `_` (e.g., `_internalHelper`, `_formatError`)
- **Variables**: `camelCase` (e.g., `resultData`, `itemCount`)
- **Files**: `kebab-case.ts` or match the module name (e.g., `search-index.ts`, `config.ts`)

#### Logging

Use `bagofcli` or a dedicated logger — never use `console.log` directly in library code.

For CLI output, use the logger provided by `bagofcli`:

```ts
import bag from "bagofcli";

bag.cli.exit(err, result);
```

**Guidelines**:

- Use `console.error` only for fatal/unexpected errors in CLI entry points
- Library modules must not call `console.log` or `process.exit` directly
- Throw errors and let them propagate

### File Organization

#### Module Structure

```ts
// 1. Strict mode directive
"use strict";

// 2. Imports — built-ins, then third-party, then local
import fs from "node:fs";
import pino from "pino";
import { loadConfig } from "./config.js";

// 3. Constants
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;

// 4. Types, then class or function definitions
interface MyModuleOptions {
  timeout?: number;
}

class MyModule {
  ...
}

// 5. Export
export default MyModule;
```

#### CLI Entry Points

CLI files live in `bin/` as plain JavaScript and delegate all logic to the compiled `lib/` in `dist/`:

```js
#!/usr/bin/env node
"use strict";
import cli from "../dist/cli.js";
cli.exec();
```

#### Command Configuration

CLI commands are defined in `conf/commands.json`, including argument validation (required options, allowed choices, numeric ranges), which bagofcli enforces:

```json
{
  "commands": {
    "mycommand": {
      "desc": "Description of the command",
      "options": [
        {
          "arg": "-f, --flag",
          "desc": "Flag description"
        }
      ]
    }
  }
}
```

### Error Handling

#### Throw Errors, Don't Return Them

```ts
// Good: throw from async functions and let the caller decide
async function readConfig(file: string): Promise<Config> {
  const text = await fs.promises.readFile(file, "utf8");
  return JSON.parse(text) as Config;
}
```

- Use `Error` subclasses with a stable `code` for errors that callers or users act on
- Include an actionable hint in user-facing errors
- Catch errors only where they can be handled or reported (e.g. at the CLI boundary)

#### Propagate Errors Up

```ts
async function processAll(items: Item[]): Promise<void> {
  for (const item of items) {
    await processOne(item); // a rejection stops the loop and propagates
  }
}
```

### JSDoc Documentation

Add JSDoc comments to all public classes and methods; TypeDoc (`make doc`) generates the API documentation from them and the TypeScript types:

```ts
/**
 * Process a list of items in batches.
 *
 * @param {Array} items - list of items to process
 * @param {Number} batchSize - number of items per batch
 * @return {Promise} processed items
 */
async function processBatch(items: Item[], batchSize: number): Promise<Item[]> {
  ...
}
```

**Guidelines**:

- Document all parameters with `@param {Type} name - description`; JSDoc
  takes the first word as the parameter name, so a `name:` colon would become
  part of the name
- Document object properties as nested params, e.g.
  `@param {Boolean} [opts.dryRun] - description`, using `[name]` for optional
  params and `[name=default]` for defaults
- Document return value with `@return {Type} description`
- Start each file with a `@module` tag so that the documentation groups its
  functions under the module instead of listing them as globals
- Mark internal helpers (`_` prefixed) with `@private`

## Testing

Applies to: `test/**/*.ts`, `test-integration/**/*.ts`

- Unit tests live in `test/`
- Integration tests live in `test-integration/`
- Tests are TypeScript, run by Mocha through `tsx` (no separate compile step)
- Run tests with `make test` and `make test-integration`

### Test Structure

#### Unit Tests

**Location**: `test/<module>.ts`, mirroring `lib/` (e.g. `test/util/semaphore.ts` for `lib/util/semaphore.ts`)

**Purpose**: Test individual functions/methods in isolation

**Scope**:

- No filesystem and network calls (mock them)
- Faster execution
- High code coverage

#### Integration Tests

**Location**: `test-integration/<module>.ts`

**Purpose**: Test end-to-end flows with real or semi-real external systems

**Scope**:

- May use filesystem and network calls (with test fixtures or mocks if needed)
- Slower execution
- Broader coverage (fewer, larger tests)
- CLI behaviour (help, option validation, exit codes) is tested by running the CLI as a process in `test-integration/cli.ts`

#### Test Files

```text
test/
  config.ts            # Tests for lib/config.ts
  util/semaphore.ts    # Tests for lib/util/semaphore.ts
  helpers/             # Shared test helpers (not run as tests)
  fixtures/            # Test fixtures (not run as tests)

test-integration/
  cli.ts               # Integration tests for the CLI
  helpers/             # Shared integration helpers
```

#### Test Suites

Use `describe` blocks to group tests by module and method:

```ts
describe("modulename - methodname", function () {
  ...
});

describe("cli - exec", function () {
  ...
});

describe("config - load", function () {
  ...
});
```

**Pattern**: `<modulename> - <methodname>`

#### Test Cases

```ts
it("should do something when condition", async function () {
  ...
});

it("should reject with an error when input is invalid", async function () {
  ...
});

it("should construct commands and pass them to series", async function () {
  ...
});
```

**Pattern**: `should <expected behaviour> when <condition>`

### Mocha Execution

#### Running Tests

```bash
# All tests
make test
make test-integration

# Specific file
node_modules/.bin/mocha test/config.ts

# Test matching a keyword
node_modules/.bin/mocha --grep "load"
```

#### Configuration

- Framework: `mocha`
- Unit test configuration lives in `package.json` (`"mocha"`: `tsx` loader, `.ts` extension, `test/**/*.ts`, timeout `15000ms`)
- `make test-integration` passes its own flags (`test-integration/**/*.ts`, timeout `180000ms`)
- Coverage: `c8` (via `make coverage`)

### Mocking Best Practices

#### Import Mocking

```ts
import sinon from "sinon";
import referee from "@sinonjs/referee";
```

#### Sinon Mocks and Stubs

Use `sinon.mock()` for verifiable mock expectations and `sinon.stub()` for simple replacements:

```ts
describe("mymodule - process", function () {
  beforeEach(function () {
    this.mockFs = sinon.mock(fs.promises);
  });

  afterEach(function () {
    this.mockFs.verify();
    this.mockFs.restore();
  });

  it("should read file and process contents", async function () {
    this.mockFs
      .expects("readFile")
      .once()
      .withExactArgs("config.json", "utf8")
      .resolves('{"key":"value"}');
    const result = await mymodule.process("config.json");
    referee.assert.equals(result.key, "value");
  });
});
```

#### Stub Values

Use `sinon.stub().value()` to replace module-level imports or object properties:

```ts
sinon.stub(bag, "command").value(function (base, actions) {
  actions.commands.release.action({ releaseIncrementType: "minor" });
});
```

#### Restore After Each Test

Always restore mocks and stubs in `afterEach` to avoid cross-test pollution:

```ts
afterEach(function () {
  this.mockDependency.verify();
  this.mockDependency.restore();
  sinon.restore();
});
```

#### Mock Structure

```ts
// Create mock
this.mockRunner = sinon.mock(runner);

// Set expectations
this.mockRunner
  .expects("execSeries")
  .withArgs(["command1", "command2"])
  .resolves("someresult");

// Verify and restore
this.mockRunner.verify();
this.mockRunner.restore();
```

#### Mocking Async Functions

Use `resolves(value)` and `rejects(error)` to simulate promise-returning functions:

```ts
this.mockRunner.expects("execSeries").once().resolves("someresult");
this.mockRunner.expects("execSeries").once().rejects(new Error("someerror"));
```

#### Mocking File I/O

```ts
this.mockFs
  .expects("readFileSync")
  .once()
  .withExactArgs("/some/package.json")
  .returns(JSON.stringify({ version: "1.2.3" }));
```

### Test Assertion Patterns

Use `@sinonjs/referee` for assertions:

```ts
import referee from "@sinonjs/referee";
const { assert, refute } = referee;
```

#### Basic Assertions

```ts
// Null / undefined
referee.assert.isNull(err);
referee.assert.isUndefined(result);

// Equality
referee.assert.equals(result, "expectedvalue");
referee.assert.equals(err.message, "someerror");

// Type checking
referee.assert.isString(base);
referee.assert.isFunction(actions.commands.release.action);

// Truthiness
referee.assert.isTrue(flag);
referee.assert.isFalse(flag);
```

#### Asserting Rejections

```ts
await referee.assert.rejects(
  mymodule.process("missing.json"),
  referee.match({ message: referee.match(/not found/) }),
);
```

#### Mock Assertions

```ts
// Expectation set via sinon mock — verified in afterEach
this.mockRunner.expects("execSeries").once();
this.mockRunner.verify(); // called in afterEach

// Manual assertion on stub call count
referee.assert.equals(stubFn.callCount, 2);
```

### Test File Structure

```ts
"use strict";
import referee from "@sinonjs/referee";
import sinon from "sinon";

import dependency from "../lib/dependency.js";
import MyClass from "../lib/mymodule.js";

const { assert, match } = referee;

describe("mymodule - methodname", function () {
  beforeEach(function () {
    this.mockDependency = sinon.mock(dependency);
  });

  afterEach(function () {
    this.mockDependency.verify();
    this.mockDependency.restore();
  });

  it("should do expected thing when condition is met", async function () {
    this.mockDependency.expects("someMethod").once().resolves("result");

    const instance = new MyClass({});
    assert.equals(await instance.methodname("input"), "result");
  });

  it("should reject with an error when dependency fails", async function () {
    this.mockDependency
      .expects("someMethod")
      .once()
      .rejects(new Error("someerror"));

    const instance = new MyClass({});
    await assert.rejects(
      instance.methodname("input"),
      match({ message: "someerror" }),
    );
  });
});
```

### Coverage

#### Generate Coverage Report

```bash
make coverage
```

#### Coverage Goals

- Aim for >= 90% code coverage
- Focus on critical paths (success flows, error handling)
- Be pedantic and don't ignore trivial getters/setters

#### Coverage Tooling

- Coverage engine: `c8`, limited to `lib/` (`--include=lib`)
- Unit coverage output: `stage/gh-pages/coverage/c8/`
- LCOV report: `stage/gh-pages/coverage/c8/lcov.info`
- HTML report: `stage/gh-pages/coverage/c8/index.html`

#### Coverage Guidelines

- Prioritise meaningful branch and error-path coverage, not just line coverage
- Add tests for both rejected and fulfilled paths of async functions
- Include coverage for CLI command option parsing and command dispatch
- Keep unit tests deterministic and isolated from network/filesystem unless explicitly integration tests

### CI Integration

Tests are run as part of `make ci`:

```bash
make test              # Unit tests
make test-integration  # Integration tests
```

All tests must pass before merging.

## Documentation

- API documentation is generated with TypeDoc via `make doc`
- Generated outputs live under `stage/`, which `make clean` removes

Generated subdirectories under `stage/`:

- `gh-pages/coverage/c8/` for coverage reports
- `gh-pages/complexity/eslint/index.html` for the complexity report
- `gh-pages/doc/typedoc/` for generated API documentation
- `package/` for the npm package archive

Everything under `stage/gh-pages/` is published to GitHub Pages by the CI workflow.

## Continuous Integration Pipeline

The Makefile (Olympia) orchestrates standard build targets, with `make ci` running the following steps in sequence:

- clean             # 1. Clean temp files
- build             # 2. Compile TypeScript (tsc)
- typecheck         # 3. Type-check sources and tests (tsc --noEmit)
- style             # 4. Format code (prettier)
- lint              # 5. Static analysis (eslint, mdl)
- test              # 6. Unit tests (mocha)
- coverage          # 7. Coverage reports (c8)
- complexity        # 8. Complexity report (eslint complexity rule)
- doc               # 9. Generate documentation (typedoc)
- package           # 10. Build npm package archive (npm pack)
- reinstall         # 11. Clean install from package
- test-integration  # 12. Integration tests (mocha)

Dependencies are installed beforehand with `make deps`.

All steps must pass before code is merged. Developers should run `make ci` locally before pushing to ensure the CI pipeline will pass.

After the code is merged, the CI pipeline will run as GitHub CI workflow.

### Common Commit Message Patterns

Use clear, imperative commit messages:

- `Fix test patch paths by avoiding command/module name collisions`
- `Add unit tests for blur-plates module`
- `Update README and example script to use categorise-orientation`
- `Remove deprecated blur-plates module and related code`

## GitHub Workflows

This repository defines the following workflows under `.github/workflows/`:

- **CI** (`ci-workflow.yaml`): Trigger: `push`, `pull_request`, and manual `workflow_dispatch`. Purpose: Runs `make deps` and `make ci` across a Node.js version matrix (usually LTS versions), publishes coverage to Coveralls, and publishes the `stage/gh-pages/` reports and docs to GitHub Pages.

- **CodeQL** (`codeql-analysis.yml`): Trigger: `push` to `main`, `pull_request` targeting `main`, and weekly scheduled run (`cron`). Purpose: Performs GitHub CodeQL static security analysis for JavaScript and TypeScript and uploads code scanning results.

- **Publish** (`publish-workflow.yaml`): Trigger: `push` of any Git tag. Purpose: Installs the package (which builds `dist/` through the `prepare` hook), then publishes it with `npm publish` via npm's trusted publishing (no stored token required).

- **Release Major** (`release-major-workflow.yaml`): Trigger: Manual `workflow_dispatch`. Purpose: Creates a major release via `cliffano/release-action` (`release_type: major`).

- **Release Minor** (`release-minor-workflow.yaml`): Trigger: Manual `workflow_dispatch`. Purpose: Creates a minor release via `cliffano/release-action` (`release_type: minor`).

- **Release Patch** (`release-patch-workflow.yaml`): Trigger: Manual `workflow_dispatch`. Purpose: Creates a patch release via `cliffano/release-action` (`release_type: patch`).

- **Upgrade Deps** (`upgrade-deps-workflow.yaml`): Trigger: Manual `workflow_dispatch`. Purpose: Runs `make deps`, `make deps-upgrade` (npm-check-updates) and `make ci`, then commits the dependency updates and pushes them back to the current branch.
