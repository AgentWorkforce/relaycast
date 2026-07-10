import test from "node:test";
import assert from "node:assert/strict";

import {
  getSageBaseUrlForStage,
  getSageDomainForStage,
  getSageStageForStage,
} from "../infra/sage-routing.js";

test("production routes to the production Sage worker", () => {
  assert.equal(getSageStageForStage("production"), "production");
  assert.equal(getSageDomainForStage("production"), "sage.agentrelay.com");
  assert.equal(getSageBaseUrlForStage("production"), "https://sage.agentrelay.com");
});

test("preview stages route to the staging Sage worker", () => {
  assert.equal(getSageStageForStage("staging"), "staging");
  assert.equal(getSageStageForStage("pr-842"), "staging");
  assert.equal(getSageDomainForStage("pr-842"), "staging.sage.agentrelay.com");
  assert.equal(
    getSageBaseUrlForStage("pr-842"),
    "https://staging.sage.agentrelay.com",
  );
});

test("dev-family stages route to the dev Sage worker", () => {
  assert.equal(getSageStageForStage("dev"), "dev");
  assert.equal(getSageStageForStage("khaliq"), "dev");
  assert.equal(getSageDomainForStage("khaliq"), "dev.sage.agentrelay.com");
  assert.equal(getSageBaseUrlForStage("khaliq"), "https://dev.sage.agentrelay.com");
});

test("prod alias normalizes to the production Sage worker", () => {
  assert.equal(getSageStageForStage("prod"), "production");
  assert.equal(getSageBaseUrlForStage("prod"), "https://sage.agentrelay.com");
});
