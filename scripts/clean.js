#!/usr/bin/env node
"use strict";
// Remove build and test output directories.
import fs from "node:fs";

for (const dir of ["dist", ".bob", "stage", "coverage"]) {
  fs.rmSync(dir, { recursive: true, force: true });
}
