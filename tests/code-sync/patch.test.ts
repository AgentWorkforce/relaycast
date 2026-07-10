import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  initGitBaseline,
  generatePatch,
  downloadPatch,
  applyPatch,
  downloadAndApplyPatch,
} from "../../packages/core/src/code-sync/patch.js";
import { createMockSandbox, tmpDir } from "./helpers.js";

describe("initGitBaseline", () => {
  it("calls git init, then config, then add+commit on sandbox", async () => {
    const { sandbox, commands } = createMockSandbox();
    await initGitBaseline(sandbox, "/project");

    assert.equal(commands.length, 3);
    assert.ok(commands[0].command.includes("git init"));
    assert.equal(commands[0].cwd, "/project");
    assert.ok(commands[1].command.includes("git config user.email"));
    assert.ok(commands[1].command.includes("git config user.name"));
    assert.equal(commands[1].cwd, "/project");
    assert.ok(commands[2].command.includes("git add -A"));
    assert.ok(commands[2].command.includes("git commit"));
    assert.equal(commands[2].cwd, "/project");
  });

  it("propagates errors if git command fails", async () => {
    const { sandbox } = createMockSandbox();
    sandbox.process.executeCommand = async () => {
      return { exitCode: 128, result: "fatal: not a repo" };
    };

    await assert.rejects(
      () => initGitBaseline(sandbox, "/project"),
      (err: any) => {
        assert.ok(err.message.includes("128"));
        return true;
      }
    );
  });
});

describe("generatePatch", () => {
  it("returns hasChanges: true when diff produces output", async () => {
    const { sandbox, commands } = createMockSandbox();
    sandbox.process.executeCommand = async (command: string, cwd?: string) => {
      commands.push({ command, cwd });
      if (command.includes("test -s")) {
        return { exitCode: 0, result: "HAS_CHANGES" };
      }
      return { exitCode: 0, result: "" };
    };

    const result = await generatePatch(sandbox, "/project", "/shared/changes.patch");

    assert.equal(result.hasChanges, true);
    assert.equal(result.patchPath, "/shared/changes.patch");
    assert.ok(commands.some((c) => c.command === "git add -A"));
    assert.ok(commands.some((c) => c.command.includes("git diff --cached HEAD >")));
    assert.ok(commands.some((c) => c.command.includes("test -s")));
  });

  it("returns hasChanges: false when diff is empty", async () => {
    const { sandbox, commands } = createMockSandbox();
    sandbox.process.executeCommand = async (command: string, cwd?: string) => {
      commands.push({ command, cwd });
      if (command.includes("test -s")) {
        return { exitCode: 0, result: "NO_CHANGES" };
      }
      return { exitCode: 0, result: "" };
    };

    const result = await generatePatch(sandbox, "/project");

    assert.equal(result.hasChanges, false);
    assert.equal(result.patchPath, "/shared/changes.patch");
  });
});

describe("downloadPatch", () => {
  it("downloads and returns patch content as string", async () => {
    const { sandbox } = createMockSandbox();
    const patchContent = "diff --git a/file.txt b/file.txt\n+added\n";
    sandbox.fs.downloadFile = async () => Buffer.from(patchContent);

    const result = await downloadPatch(sandbox, "/shared/changes.patch");
    assert.equal(result, patchContent);
  });

  it("uses default patch path", async () => {
    const { sandbox } = createMockSandbox();
    let requestedPath = "";
    sandbox.fs.downloadFile = async (p: string) => {
      requestedPath = p;
      return Buffer.from("patch");
    };

    await downloadPatch(sandbox);
    assert.equal(requestedPath, "/shared/changes.patch");
  });
});

describe("applyPatch", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns applied: false for empty patch", async () => {
    const result = await applyPatch(root, "   ");
    assert.equal(result.applied, false);
    assert.ok(result.output.includes("No changes"));
  });

  it("applies a valid patch and returns applied: true", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: root });
    execSync('git config user.email "test@test"', { cwd: root });
    execSync('git config user.name "test"', { cwd: root });
    await writeFile(path.join(root, "file.txt"), "original\n");
    execSync("git add -A && git commit -m init", { cwd: root });

    const patch = `diff --git a/file.txt b/file.txt
index 0ee3856..c78cc34 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1,2 @@
 original
+added line
`;
    const result = await applyPatch(root, patch);
    assert.equal(result.applied, true);
  });
});

describe("downloadAndApplyPatch", () => {
  let root: string;

  beforeEach(async () => {
    root = await tmpDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("downloads patch, writes temp file, calls git apply, returns applied: true", async () => {
    const { sandbox } = createMockSandbox();

    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: root });
    execSync('git config user.email "test@test"', { cwd: root });
    execSync('git config user.name "test"', { cwd: root });
    await writeFile(path.join(root, "file.txt"), "original\n");
    execSync("git add -A && git commit -m init", { cwd: root });

    const realPatch = `diff --git a/file.txt b/file.txt
index 0ee3856..c78cc34 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1,2 @@
 original
+added line
`;
    sandbox.fs.downloadFile = async () => Buffer.from(realPatch);

    const result = await downloadAndApplyPatch(sandbox, root, "/shared/changes.patch");
    assert.equal(result.applied, true);
  });

  it("returns applied: false with error message when git apply fails", async () => {
    const invalidPatch = "this is not a valid patch";
    const { sandbox } = createMockSandbox();
    sandbox.fs.downloadFile = async () => Buffer.from(invalidPatch);

    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: root });
    execSync('git config user.email "test@test"', { cwd: root });
    execSync('git config user.name "test"', { cwd: root });
    await writeFile(path.join(root, "dummy.txt"), "x");
    execSync("git add -A && git commit -m init", { cwd: root });

    const result = await downloadAndApplyPatch(sandbox, root, "/shared/changes.patch");
    assert.equal(result.applied, false);
    assert.ok(result.output.length > 0, "should include error message");
  });
});
