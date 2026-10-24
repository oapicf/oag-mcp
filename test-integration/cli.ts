"use strict";
/**
 * The CLI surface: help, command and option validation, run as a real
 * process. Each case checks the exit code and a fragment of the combined
 * stdout and stderr.
 */
import referee from "@sinonjs/referee";

import { SDK_726, SPEC, runCli } from "./helpers/env.js";

const { assert } = referee;

const SERVE = ["serve", "--spec", SPEC, "--sdk", SDK_726];

const CASES: Array<{
  description: string;
  args: string[];
  exitcode: number;
  output: string;
}> = [
  {
    description: "should display help information",
    args: ["--help"],
    exitcode: 0,
    output: "Usage: oag-mcp",
  },
  {
    description: "should list the spec and SDK options in serve help",
    args: ["serve", "--help"],
    exitcode: 0,
    output: "--sdk <sdk>",
  },
  {
    description: "should reject unknown commands",
    args: ["frobnicate"],
    exitcode: 1,
    output: "unknown command 'frobnicate'",
  },
  {
    description: "should reject positional arguments to serve",
    args: [
      "serve",
      "./openapi.yaml",
      ...SERVE.slice(1),
      "--log-level",
      "silent",
    ],
    exitcode: 1,
    output: "too many arguments for 'serve'",
  },
  {
    description: "should require an SDK",
    args: ["serve", "--spec", SPEC, "--log-level", "silent"],
    exitcode: 1,
    output: "<--sdk <sdk>> must be required",
  },
  {
    description: "should require a spec",
    args: ["serve", "--sdk", SDK_726, "--log-level", "silent"],
    exitcode: 1,
    output: "<--spec <spec>> must be required",
  },
  {
    description: "should reject a missing SDK with an actionable error",
    args: [
      "serve",
      "--spec",
      SPEC,
      "--sdk",
      "does-not-exist",
      "--log-level",
      "silent",
    ],
    exitcode: 1,
    output: "SDK_NOT_FOUND",
  },
  {
    description: "should reject an SDK from another generator layout",
    args: [...SERVE, "--sdk-layout", "compiled", "--log-level", "silent"],
    exitcode: 1,
    output: "SDK_LAYOUT_UNSUPPORTED",
  },
  {
    description: "should reject legacy HTTP+SSE as a transport",
    args: [...SERVE, "--transport", "sse", "--log-level", "silent"],
    exitcode: 1,
    output: "streamable-http",
  },
  {
    description: "should reject an unknown SDK layout",
    args: [...SERVE, "--sdk-layout", "weird", "--log-level", "silent"],
    exitcode: 1,
    output: "Allowed choices are auto, source, compiled",
  },
  {
    description: "should reject a port outside 0-65535",
    args: [
      ...SERVE,
      "--transport",
      "streamable-http",
      "--port",
      "99999",
      "--log-level",
      "silent",
    ],
    exitcode: 1,
    output: "--port must be an integer between 0 and 65535",
  },
  {
    description: "should reject a non-integer port",
    args: [
      ...SERVE,
      "--transport",
      "streamable-http",
      "--port",
      "3.5",
      "--log-level",
      "silent",
    ],
    exitcode: 1,
    output: "--port must be an integer between 0 and 65535",
  },
  {
    description: "should reject an unknown log level",
    args: [...SERVE, "--log-level", "loud"],
    exitcode: 1,
    output:
      "Allowed choices are fatal, error, warn, info, debug, trace, silent",
  },
];

describe("cli - commands", function () {
  for (const c of CASES) {
    it(c.description, function () {
      this.timeout(60000);
      const res = runCli(c.args);
      const output = `${res.stdout}${res.stderr}`;
      assert.equals(res.status, c.exitcode, output);
      assert.contains(output, c.output);
    });
  }
});
