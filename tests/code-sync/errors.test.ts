import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SandboxCommandError, PatchApplyError } from "../../packages/core/src/code-sync/errors.js";

describe("SandboxCommandError", () => {
  it("stores properties and has correct message format", () => {
    const err = new SandboxCommandError("git init", 128, "fatal: not a repo");
    assert.equal(err.command, "git init");
    assert.equal(err.exitCode, 128);
    assert.equal(err.output, "fatal: not a repo");
    assert.ok(err.message.includes("128"));
    assert.ok(err.message.includes("git init"));
    assert.ok(err instanceof Error);
    assert.equal(err.name, "SandboxCommandError");
  });
});

describe("PatchApplyError", () => {
  it("stores patchPath and is instanceof Error", () => {
    const err = new PatchApplyError("/shared/changes.patch", "patch failed");
    assert.equal(err.patchPath, "/shared/changes.patch");
    assert.equal(err.message, "patch failed");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "PatchApplyError");
  });
});
