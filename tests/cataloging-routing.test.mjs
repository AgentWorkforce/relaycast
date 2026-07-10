import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getCatalogingDomainForStage } from "../infra/cataloging-routing";

describe("cataloging routing", () => {
  it("keeps production cataloging on the existing agentrelay.cloud hosts", () => {
    assert.equal(
      getCatalogingDomainForStage("github", "production"),
      "catalog-github.production.agentrelay.cloud",
    );
    assert.equal(
      getCatalogingDomainForStage("linear", "prod"),
      "catalog-linear.production.agentrelay.cloud",
    );
    assert.equal(
      getCatalogingDomainForStage("linear", " PROD "),
      "catalog-linear.production.agentrelay.cloud",
    );
  });

  it("moves non-production cataloging hosts to agentrelay.com", () => {
    assert.equal(
      getCatalogingDomainForStage("github", "staging"),
      "catalog-github.staging.agentrelay.com",
    );
    assert.equal(
      getCatalogingDomainForStage("linear", "dev"),
      "catalog-linear.dev.agentrelay.com",
    );
    assert.equal(
      getCatalogingDomainForStage("github", "pr-123"),
      "catalog-github.pr-123.agentrelay.com",
    );
    assert.equal(
      getCatalogingDomainForStage("github", " Staging "),
      "catalog-github.staging.agentrelay.com",
    );
  });

  it("rejects empty stage values", () => {
    assert.throws(
      () => getCatalogingDomainForStage("linear", " "),
      /cataloging stage is required/,
    );
  });
});
