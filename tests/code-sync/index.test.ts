import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpDir, writeFileAt, createMockSandbox } from "./helpers.js";

describe("barrel exports", () => {
  it("re-exports all public symbols", async () => {
    const mod = await import("../../packages/core/src/code-sync/index.js");

    // Types are erased at runtime, but functions/classes/constants should exist
    assert.equal(typeof mod.scanDirectory, "function");
    assert.equal(typeof mod.hashFiles, "function");
    assert.equal(typeof mod.serializeManifest, "function");
    assert.equal(typeof mod.deserializeManifest, "function");
    assert.equal(typeof mod.diffManifests, "function");
    assert.equal(typeof mod.syncToSandbox, "function");
    assert.equal(typeof mod.initGitBaseline, "function");
    assert.equal(typeof mod.generatePatch, "function");
    assert.equal(typeof mod.downloadPatch, "function");
    assert.equal(typeof mod.applyPatch, "function");
    assert.equal(typeof mod.downloadAndApplyPatch, "function");
    assert.equal(typeof mod.codeSync, "function");
    assert.equal(typeof mod.exec, "function");
    assert.equal(typeof mod.asSandboxLike, "function");
    assert.equal(typeof mod.SandboxCommandError, "function");
    assert.equal(typeof mod.PatchApplyError, "function");
    assert.equal(typeof mod.MANIFEST_FILENAME, "string");
    assert.equal(typeof mod.DEFAULT_PATCH_PATH, "string");
    assert.equal(typeof mod.TMP_TAR_PATH, "string");
  });
});

describe("codeSync wrapper", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does NOT call initGitBaseline", async () => {
    await writeFileAt(root, "hello.txt", "world");
    const { sandbox, commands } = createMockSandbox();
    const { codeSync } = await import("../../packages/core/src/code-sync/index.js");

    await codeSync({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
    });

    // Should NOT have git init — that's the orchestrator's job now
    const gitInitCmd = commands.find((c) => c.command === "git init");
    assert.equal(gitInitCmd, undefined, "codeSync should NOT call initGitBaseline");
  });
});
