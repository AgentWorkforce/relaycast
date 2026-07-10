import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import type { SyncPlan } from "../../packages/core/src/code-sync/types.js";
import { syncToSandbox } from "../../packages/core/src/code-sync/sync.js";
import { hashFiles } from "../../packages/core/src/code-sync/manifest.js";
import { tmpDir, writeFileAt, createMockSandbox } from "./helpers.js";

describe("syncToSandbox", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uploads tar archive for added files", async () => {
    await writeFileAt(root, "new.txt", "hello");
    const { sandbox, uploaded, commands } = createMockSandbox();
    const manifest = await hashFiles(root, ["new.txt"]);
    const plan: SyncPlan = {
      added: ["new.txt"],
      modified: [],
      deleted: [],
      unchanged: [],
      stats: { toUpload: 1, toDelete: 0, unchanged: 0 },
    };

    const result = await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest,

      plan,
    });

    assert.equal(result.uploaded, 1);
    const tarUpload = uploaded.find((u) => u.remotePath === "/tmp/code-sync.tar.gz");
    assert.ok(tarUpload, "should upload tar archive to /tmp/code-sync.tar.gz");
    assert.ok(tarUpload!.source instanceof Buffer, "tar archive should be a Buffer");
    const extractCmd = commands.find((c) => c.command.includes("tar xzf"));
    assert.ok(extractCmd, "should execute tar extract command");
    assert.ok(extractCmd!.command.includes("-C /project"), "should extract to remote path");
  });

  it("uploads tar archive for modified files", async () => {
    await writeFileAt(root, "mod.txt", "updated");
    const { sandbox, uploaded } = createMockSandbox();
    const manifest = await hashFiles(root, ["mod.txt"]);
    const plan: SyncPlan = {
      added: [],
      modified: ["mod.txt"],
      deleted: [],
      unchanged: [],
      stats: { toUpload: 1, toDelete: 0, unchanged: 0 },
    };

    const result = await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest,

      plan,
    });

    assert.equal(result.uploaded, 1);
    const tarUpload = uploaded.find((u) => u.remotePath === "/tmp/code-sync.tar.gz");
    assert.ok(tarUpload, "should upload tar archive");
  });

  it("deletes removed files via batch rm command", async () => {
    const { sandbox, commands } = createMockSandbox();
    const plan: SyncPlan = {
      added: [],
      modified: [],
      deleted: ["old.txt"],
      unchanged: [],
      stats: { toUpload: 0, toDelete: 1, unchanged: 0 },
    };

    const result = await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest: new Map(),

      plan,
    });

    assert.equal(result.deleted, 1);
    const rmCmd = commands.find((c) => c.command.includes("rm -f"));
    assert.ok(rmCmd, "should execute rm command");
    assert.ok(rmCmd!.command.includes("/project/old.txt"), "should include file path");
  });

  it("tar archive contains expected files", async () => {
    await writeFileAt(root, "src/lib/util.ts", "code");
    await writeFileAt(root, "index.ts", "entry");
    const { sandbox, uploaded } = createMockSandbox();
    const manifest = await hashFiles(root, ["src/lib/util.ts", "index.ts"]);
    const plan: SyncPlan = {
      added: ["src/lib/util.ts", "index.ts"],
      modified: [],
      deleted: [],
      unchanged: [],
      stats: { toUpload: 2, toDelete: 0, unchanged: 0 },
    };

    await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest,

      plan,
    });

    const tarUpload = uploaded.find((u) => u.remotePath === "/tmp/code-sync.tar.gz");
    assert.ok(tarUpload, "tar archive should be uploaded");

    const extractDir = await tmpDir();
    const tarPath = path.join(extractDir, "archive.tar.gz");
    await writeFile(tarPath, tarUpload!.source as Buffer);
    await tar.extract({ file: tarPath, cwd: extractDir });

    const { readFile: readF } = await import("node:fs/promises");
    const utilContent = await readF(path.join(extractDir, "src/lib/util.ts"), "utf-8");
    assert.equal(utilContent, "code");
    const indexContent = await readF(path.join(extractDir, "index.ts"), "utf-8");
    assert.equal(indexContent, "entry");

    await rm(extractDir, { recursive: true, force: true });
  });

  it("uploads manifest after sync", async () => {
    const { sandbox, uploaded } = createMockSandbox();
    const plan: SyncPlan = {
      added: [],
      modified: [],
      deleted: [],
      unchanged: [],
      stats: { toUpload: 0, toDelete: 0, unchanged: 0 },
    };

    await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest: new Map(),

      plan,
    });

    const manifestUpload = uploaded.find(
      (u) => u.remotePath === "/project/.code-sync-manifest.json"
    );
    assert.ok(manifestUpload, "should upload manifest");
    assert.ok(manifestUpload!.source instanceof Buffer, "manifest uploaded as Buffer");
  });

  it("reports errors when extract command fails", async () => {
    await writeFileAt(root, "fail.txt", "data");
    const { sandbox } = createMockSandbox();
    sandbox.process.executeCommand = async (command: string) => {
      if (command.includes("tar xzf")) {
        return { exitCode: 1, result: "tar: Error: extraction failed" };
      }
      return { exitCode: 0, result: "" };
    };

    const manifest = await hashFiles(root, ["fail.txt"]);
    const plan: SyncPlan = {
      added: ["fail.txt"],
      modified: [],
      deleted: [],
      unchanged: [],
      stats: { toUpload: 1, toDelete: 0, unchanged: 0 },
    };

    const result = await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest,

      plan,
    });

    assert.ok(result.errors.length > 0, "should report errors");
    assert.ok(
      result.errors[0].error.includes("tar extract failed"),
      "error message should mention tar extract failure"
    );
  });

  it("handles delete command with multiple files", async () => {
    const { sandbox, commands } = createMockSandbox();
    const plan: SyncPlan = {
      added: [],
      modified: [],
      deleted: ["a.txt", "b.txt", "c.txt"],
      unchanged: [],
      stats: { toUpload: 0, toDelete: 3, unchanged: 0 },
    };

    const result = await syncToSandbox({
      rootDir: root,
      sandboxDir: "/project",
      sandbox,
      manifest: new Map(),

      plan,
    });

    assert.equal(result.deleted, 3);
    const rmCmd = commands.find((c) => c.command.includes("rm -f"));
    assert.ok(rmCmd, "should batch delete with single rm command");
    assert.ok(rmCmd!.command.includes("/project/a.txt"), "should include a.txt");
    assert.ok(rmCmd!.command.includes("/project/b.txt"), "should include b.txt");
    assert.ok(rmCmd!.command.includes("/project/c.txt"), "should include c.txt");
  });
});
