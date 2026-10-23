"use strict";
import referee from "@sinonjs/referee";

import {
  AuthorizationPolicy,
  matchesOperation,
  opaquePrincipalId,
} from "../../lib/auth/policy.js";
import type { OperationBinding, Principal } from "../../lib/types.js";

const { assert, refute } = referee;

const op = (
  id: string,
  extra: Partial<OperationBinding> = {},
): OperationBinding => ({
  id,
  className: id.split(".")[0],
  methodName: id.split(".")[1],
  httpMethod: "GET",
  path: "/x",
  tags: [],
  security: [],
  ...extra,
});

const reader: Principal = {
  id: "static:reader",
  kind: "static",
  name: "reader",
  scopes: ["pets:read"],
};
const admin: Principal = {
  id: "static:admin",
  kind: "static",
  name: "admin",
  scopes: ["pets:read", "admin"],
};

describe("policy - matchesOperation", function () {
  it("should match globs, tags, methods and operationIds", function () {
    assert.isTrue(matchesOperation("PetsApi.*", op("PetsApi.listPets")));
    assert.isTrue(matchesOperation("*.list*", op("PetsApi.listPets")));
    refute(matchesOperation("PetsApi.get*", op("PetsApi.listPets")));
    assert.isTrue(
      matchesOperation("tag:pets", op("PetsApi.listPets", { tags: ["pets"] })),
    );
    assert.isTrue(matchesOperation("method:get", op("PetsApi.listPets")));
    refute(matchesOperation("method:DELETE", op("PetsApi.listPets")));
    assert.isTrue(
      matchesOperation(
        "operationId:list-*",
        op("PetsApi.listPetVisits", { operationId: "list-pet-visits" }),
      ),
    );
    refute(matchesOperation("PetsApi.list.Pets", op("PetsApi.listPets")));
  });
});

describe("policy - AuthorizationPolicy.decide", function () {
  it("should allow everything with an implicit policy when none is configured", function () {
    const p = new AuthorizationPolicy();
    const d = p.decide(reader, op("AdminApi.deletePet"));
    assert.isTrue(d.allowed);
    assert.equals(d.policyId, "implicit-allow-all");
  });

  it("should apply allow rules by scope and deny by default", function () {
    const p = new AuthorizationPolicy({
      default: "deny",
      rules: [
        {
          id: "readers",
          scopes: ["pets:read"],
          allow: ["method:GET"],
          deny: [],
        },
        { id: "admins", principals: ["admin"], allow: ["*"], deny: [] },
      ],
    });
    assert.isTrue(p.decide(reader, op("PetsApi.listPets")).allowed);
    const denied = p.decide(
      reader,
      op("AdminApi.deletePet", { httpMethod: "DELETE" }),
    );
    assert.isFalse(denied.allowed);
    assert.equals(denied.policyId, "default");
    assert.isTrue(
      p.decide(admin, op("AdminApi.deletePet", { httpMethod: "DELETE" }))
        .allowed,
    );
  });

  it("should let deny rules win over allow rules", function () {
    const p = new AuthorizationPolicy({
      default: "allow",
      rules: [
        {
          id: "no-admin",
          principals: ["*"],
          allow: ["*"],
          deny: ["AdminApi.*"],
        },
      ],
    });
    const d = p.decide(admin, op("AdminApi.deletePet"));
    assert.isFalse(d.allowed);
    assert.equals(d.policyId, "no-admin");
    assert.equals(d.reason, "rule_deny");
  });

  it("should match client ids for OAuth principals", function () {
    const p = new AuthorizationPolicy({
      default: "deny",
      rules: [
        { id: "app", clientIds: ["app-1"], allow: ["PetsApi.*"], deny: [] },
      ],
    });
    const oauth: Principal = {
      id: "oauth:abc",
      kind: "oauth",
      clientId: "app-1",
      scopes: [],
    };
    assert.isTrue(p.decide(oauth, op("PetsApi.listPets")).allowed);
    assert.isFalse(
      p.decide({ ...oauth, clientId: "app-2" }, op("PetsApi.listPets")).allowed,
    );
  });
});

describe("policy - opaquePrincipalId", function () {
  it("should be stable and not reveal the subject", function () {
    const a = opaquePrincipalId("oauth", [
      "https://issuer",
      "alice@example.com",
    ]);
    assert.equals(
      a,
      opaquePrincipalId("oauth", ["https://issuer", "alice@example.com"]),
    );
    refute.contains(a, "alice");
    assert.match(a, /^oauth:[0-9a-f]{16}$/);
  });
});
