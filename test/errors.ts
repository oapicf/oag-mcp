"use strict";
import referee from "@sinonjs/referee";

import { OagMcpError, formatCliError } from "../lib/errors.js";

const { assert } = referee;

describe("errors - OagMcpError", function () {
  it("should carry a code, hint, details and cause", function () {
    const cause = new Error("root");
    const err = new OagMcpError("SOME_CODE", "Something failed", {
      hint: "Try again",
      details: { n: 1 },
      cause,
    });
    assert.equals(err.name, "OagMcpError");
    assert.equals(err.code, "SOME_CODE");
    assert.equals(err.hint, "Try again");
    assert.equals(err.details, { n: 1 });
    assert.same(err.cause, cause);
    assert.isUndefined(new OagMcpError("X", "y").cause);
  });
});

describe("errors - formatCliError", function () {
  it("should show an oag-mcp error's code and hint", function () {
    assert.equals(
      formatCliError(
        new OagMcpError("SDK_X", "Bad SDK", { hint: "Regenerate" }),
      ),
      "Error [SDK_X]: Bad SDK\nHint: Regenerate",
    );
    assert.equals(
      formatCliError(new OagMcpError("SDK_X", "Bad SDK")),
      "Error [SDK_X]: Bad SDK",
    );
  });

  it("should show other errors and thrown values by message", function () {
    assert.equals(formatCliError(new TypeError("nope")), "Error: nope");
    assert.equals(formatCliError("plain"), "Error: plain");
    assert.equals(formatCliError(42), "Error: 42");
  });
});
