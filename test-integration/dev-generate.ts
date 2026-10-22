"use strict";
/**
 * Development tooling only: a freshly generated typescript-fetch SDK (via
 * scripts/dev/generate-sdk.ts with Java or Docker) is served unchanged by
 * oag-mcp. Skipped, with the reason printed, when the generator is not
 * available. oag-mcp itself never generates SDKs.
 */
import path from "node:path";

import referee from "@sinonjs/referee";

import { prepareSdk } from "../lib/prepare/prepare.js";
import { sha256Tree } from "../lib/util/hash.js";
import { generateSdk } from "../scripts/dev/generate-sdk.js";
import {
  LOCAL,
  SPEC,
  dockerAvailable,
  fileLogs,
  javaAvailable,
  runtimeConfig,
  service,
  workDir,
} from "./helpers/env.js";
import { startMockApi } from "./helpers/mock-api.js";

const { assert } = referee;

for (const backend of ["java", "docker"] as const) {
  describe(`dev-generate - ${backend} backend`, function () {
    it("should serve a freshly generated SDK without modifying it", async function () {
      const available =
        backend === "java" ? javaAvailable() : dockerAvailable();
      if (!available.ok) {
        console.log(`      [blocked: ${available.reason}]`);
        this.skip();
      }
      this.timeout(300000);
      const out = path.join(workDir(`gen-${backend}`), "sdk");
      await generateSdk({
        specPath: SPEC,
        outDir: out,
        version: "7.26.0",
        backend,
        additionalProperties: { npmName: "petclinic-sdk", npmVersion: "1.0.0" },
        logs: fileLogs("gen").logs,
      });
      const before = sha256Tree(out);
      const prepared = await prepareSdk({
        spec: SPEC,
        sdk: out,
        logs: fileLogs("gen-prepare").logs,
      });
      const api = await startMockApi();
      try {
        assert.equals(prepared.info.target.oagVersion, "7.26.0");
        const svc = await service(prepared, runtimeConfig(api));
        const res = await svc.execute(
          {
            code: 'return (await sdk.PetsApi.listPets({ species: "dog" })).map((p) => p.name);',
          },
          LOCAL,
        );
        assert.isTrue(res.ok, JSON.stringify(res.error));
        assert.equals(res.result, ["Biscuit", "Ziggy", "Maple"]);
      } finally {
        await api.close();
        prepared.cleanup();
      }
      assert.equals(sha256Tree(out), before);
    });
  });
}
