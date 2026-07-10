import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nameWithId } from "../src/conventions.js";

describe("nameWithId", () => {
  it("builds a slug plus stable id suffix", () => {
    assert.equal(nameWithId("Fix login flow", "issue-123"), "fix-login-flow__issue-123");
  });

  it("falls back to the id when the name is blank", () => {
    assert.equal(nameWithId("   ", "issue-123"), "issue-123");
  });

  it("keeps unicode letters stable in the slug", () => {
    assert.equal(nameWithId("修复 login", "issue-123"), "修复-login__issue-123");
  });

  it("strips path separators and existing double-underscore tokens from the slug", () => {
    assert.equal(nameWithId("ops/alerts__prod", "issue-123"), "ops-alerts-prod__issue-123");
  });

  it("keeps different ids distinct when two names normalize to the same slug", () => {
    assert.equal(nameWithId("Ops Alerts", "issue-123"), "ops-alerts__issue-123");
    assert.equal(nameWithId("ops/alerts", "issue-456"), "ops-alerts__issue-456");
  });

  it("preserves literal placeholders for convention templates", () => {
    assert.equal(nameWithId("{name}", "{id}"), "{name}__{id}");
  });

  it("trims very long names from the slug side without dropping the id suffix", () => {
    const value = nameWithId("a".repeat(400), "issue-123");
    assert.ok(value.endsWith("__issue-123"));
    assert.ok(new TextEncoder().encode(value).length <= 255);
  });

  it("throws when the id is empty", () => {
    assert.throws(() => nameWithId("Fix login flow", "   "), /non-empty id/);
  });
});
