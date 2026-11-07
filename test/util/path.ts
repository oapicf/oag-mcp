"use strict";
import referee from "@sinonjs/referee";
import { trimTrailingSlashes } from "../../lib/util/path.js";

const { assert } = referee;

describe("path - trimTrailingSlashes", function () {
  it("should remove every trailing slash and nothing else", function () {
    assert.equals(
      trimTrailingSlashes("https://a.example/v1///"),
      "https://a.example/v1",
    );
    assert.equals(trimTrailingSlashes("/pets/{id}/"), "/pets/{id}");
    assert.equals(trimTrailingSlashes("/a//b"), "/a//b");
    assert.equals(trimTrailingSlashes("///"), "");
    assert.equals(trimTrailingSlashes(""), "");
  });

  it("should take linear time on long runs of slashes", function () {
    const started = performance.now();
    assert.equals(
      trimTrailingSlashes(`${"/".repeat(200000)}a`),
      `${"/".repeat(200000)}a`,
    );
    assert.less(performance.now() - started, 100);
  });
});
