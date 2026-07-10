import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = new URL("../.github/workflows/deploy-nango-integrations.yml", import.meta.url);
const deployScript = new URL("../scripts/deploy-nango-integrations.sh", import.meta.url);

describe("deploy-nango-integrations workflow step order", () => {
  it("refreshes webhook-backed sync schedules before asserting live webhook subscriptions", () => {
    const contents = readFileSync(workflow, "utf8");
    const deployIndex = contents.indexOf("- name: Deploy Nango integrations");
    const refreshIndex = contents.indexOf("- name: Refresh Nango webhook-backed sync schedules");
    const verifyIndex = contents.indexOf("- name: Verify Nango webhook subscriptions");

    assert.notEqual(deployIndex, -1, "Deploy Nango integrations step is missing");
    assert.notEqual(refreshIndex, -1, "Refresh Nango webhook-backed sync schedules step is missing");
    assert.notEqual(verifyIndex, -1, "Verify Nango webhook subscriptions step is missing");
    assert.ok(deployIndex < refreshIndex, "Refresh must run after deploy");
    assert.ok(refreshIndex < verifyIndex, "Verify must run after refresh");
  });
});

describe("deploy-nango-integrations shell script step order", () => {
  it("refreshes webhook-backed sync schedules before asserting live webhook subscriptions", () => {
    const contents = readFileSync(deployScript, "utf8");
    const deployIndex = contents.indexOf("npx nango deploy");
    const refreshIndex = contents.indexOf("node scripts/refresh-nango-webhook-syncs.mjs");
    const verifyIndex = contents.indexOf("node scripts/assert-nango-webhook-subscriptions.mjs");

    assert.notEqual(deployIndex, -1, "Nango deploy command is missing");
    assert.notEqual(refreshIndex, -1, "Refresh command is missing");
    assert.notEqual(verifyIndex, -1, "Verify command is missing");
    assert.ok(deployIndex < refreshIndex, "Refresh must run after deploy");
    assert.ok(refreshIndex < verifyIndex, "Verify must run after refresh");
  });
});
