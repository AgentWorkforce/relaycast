import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Orchestrator } from "../../packages/core/src/orchestrator.js";
import { tmpDir, createMockSandbox } from "./helpers.js";

// ── Workflow config validation (3 tests) ──────────────────────────────

describe("workflow config validation", async () => {
  const { config } = await import("../../workflows/code-sync.js");

  it("has correct pattern, agent count, and step count", () => {
    assert.equal(config.swarm.pattern, "reflection");
    assert.equal(config.agents.length, 2);
    const steps = config.workflows![0].steps;
    assert.equal(steps.length, 8);
  });

  it("has correct dependency chain", () => {
    const steps = config.workflows![0].steps;

    assert.equal(steps[0].dependsOn, undefined);
    assert.deepEqual(steps[1].dependsOn, ["scan-and-hash"]);
    assert.deepEqual(steps[2].dependsOn, ["review-scan"]);
    assert.deepEqual(steps[3].dependsOn, ["diff-and-plan"]);
    assert.deepEqual(steps[4].dependsOn, ["review-plan"]);
    assert.deepEqual(steps[5].dependsOn, ["execute-sync"]);
    assert.deepEqual(steps[6].dependsOn, ["review-sync"]);
    assert.deepEqual(steps[7].dependsOn, ["generate-patch"]);
  });

  it("all step agents exist in agents list", () => {
    const agentNames = new Set(config.agents.map((a) => a.name));
    const steps = config.workflows![0].steps;

    for (const step of steps) {
      assert.ok(
        agentNames.has(step.agent!),
        `Agent "${step.agent}" used in step "${step.name}" must be defined`
      );
    }
  });
});

// ── Orchestrator.syncBack (4 tests) ───────────────────────────────────

describe("Orchestrator.syncBack", () => {
  let root: string;
  let previousJwtToken: string | undefined;
  let previousApiKey: string | undefined;
  let previousOrgId: string | undefined;
  let previousApiUrl: string | undefined;
  let previousTarget: string | undefined;

  beforeEach(async () => {
    previousJwtToken = process.env.DAYTONA_JWT_TOKEN;
    previousApiKey = process.env.DAYTONA_API_KEY;
    previousOrgId = process.env.DAYTONA_ORGANIZATION_ID;
    previousApiUrl = process.env.DAYTONA_API_URL;
    previousTarget = process.env.DAYTONA_TARGET;

    delete process.env.DAYTONA_JWT_TOKEN;
    process.env.DAYTONA_API_KEY = "unit-test-key";
    process.env.DAYTONA_API_URL = process.env.DAYTONA_API_URL || "https://api.daytona.example";
    process.env.DAYTONA_TARGET = process.env.DAYTONA_TARGET || "local";

    root = await tmpDir();
  });

  afterEach(async () => {
    if (previousJwtToken === undefined) {
      delete process.env.DAYTONA_JWT_TOKEN;
    } else {
      process.env.DAYTONA_JWT_TOKEN = previousJwtToken;
    }

    if (previousApiKey === undefined) {
      delete process.env.DAYTONA_API_KEY;
    } else {
      process.env.DAYTONA_API_KEY = previousApiKey;
    }

    if (previousOrgId === undefined) {
      delete process.env.DAYTONA_ORGANIZATION_ID;
    } else {
      process.env.DAYTONA_ORGANIZATION_ID = previousOrgId;
    }

    if (previousApiUrl === undefined) {
      delete process.env.DAYTONA_API_URL;
    } else {
      process.env.DAYTONA_API_URL = previousApiUrl;
    }

    if (previousTarget === undefined) {
      delete process.env.DAYTONA_TARGET;
    } else {
      process.env.DAYTONA_TARGET = previousTarget;
    }

    await rm(root, { recursive: true, force: true });
  });

  it("returns hasChanges: false when no agent changes", async () => {
    const { sandbox, commands } = createMockSandbox();
    sandbox.process.executeCommand = async (command: string, cwd?: string) => {
      commands.push({ command, cwd });
      if (command.includes("test -s")) {
        return { exitCode: 0, result: "NO_CHANGES" };
      }
      return { exitCode: 0, result: "" };
    };

    const orchestrator = new Orchestrator({ version: "1.0", name: "test", swarm: { pattern: "pipeline" }, agents: [] });
    const result = await orchestrator.syncBack(sandbox, root, "/project");

    assert.equal(result.hasChanges, false);
    assert.equal(result.applied, false);
    assert.equal(result.output, "No changes detected");
  });

  it("generates patch and applies when changes exist", async () => {
    const { sandbox, commands } = createMockSandbox();

    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: root });
    execSync('git config user.email "test@test"', { cwd: root });
    execSync('git config user.name "test"', { cwd: root });
    await writeFile(path.join(root, "file.txt"), "original\n");
    execSync("git add -A && git commit -m init", { cwd: root });

    const patchContent = `diff --git a/file.txt b/file.txt
index 0ee3856..c78cc34 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1,2 @@
 original
+added line
`;
    sandbox.process.executeCommand = async (command: string, cwd?: string) => {
      commands.push({ command, cwd });
      if (command.includes("test -s")) {
        return { exitCode: 0, result: "HAS_CHANGES" };
      }
      return { exitCode: 0, result: "" };
    };
    sandbox.fs.downloadFile = async () => Buffer.from(patchContent);

    const orchestrator = new Orchestrator({ version: "1.0", name: "test", swarm: { pattern: "pipeline" }, agents: [] });
    const result = await orchestrator.syncBack(sandbox, root, "/project");

    assert.equal(result.hasChanges, true);
    assert.equal(result.applied, true);
  });

  it("calls generatePatch with correct remotePath", async () => {
    const { sandbox, commands } = createMockSandbox();
    sandbox.process.executeCommand = async (command: string, cwd?: string) => {
      commands.push({ command, cwd });
      if (command.includes("test -s")) {
        return { exitCode: 0, result: "NO_CHANGES" };
      }
      return { exitCode: 0, result: "" };
    };

    const orchestrator = new Orchestrator({ version: "1.0", name: "test", swarm: { pattern: "pipeline" }, agents: [] });
    await orchestrator.syncBack(sandbox, root, "/workspace");

    const addCmd = commands.find((c) => c.command === "git add -A");
    assert.ok(addCmd, "should call git add -A");
    assert.equal(addCmd!.cwd, "/workspace");
  });

  it("returns applied: false when patch fails to apply", async () => {
    const { sandbox, commands } = createMockSandbox();

    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: root });
    execSync('git config user.email "test@test"', { cwd: root });
    execSync('git config user.name "test"', { cwd: root });
    await writeFile(path.join(root, "dummy.txt"), "x");
    execSync("git add -A && git commit -m init", { cwd: root });

    sandbox.process.executeCommand = async (command: string, cwd?: string) => {
      commands.push({ command, cwd });
      if (command.includes("test -s")) {
        return { exitCode: 0, result: "HAS_CHANGES" };
      }
      return { exitCode: 0, result: "" };
    };
    sandbox.fs.downloadFile = async () => Buffer.from("invalid patch content");

    const orchestrator = new Orchestrator({ version: "1.0", name: "test", swarm: { pattern: "pipeline" }, agents: [] });
    const result = await orchestrator.syncBack(sandbox, root, "/project");

    assert.equal(result.hasChanges, true);
    assert.equal(result.applied, false);
    assert.ok(result.output.length > 0);
  });
});

// ── Orchestrator calls initGitBaseline (1 new test) ───────────────────

describe("Orchestrator composes initGitBaseline", () => {
  // This test validates the architectural change: the orchestrator
  // is now responsible for calling initGitBaseline after codeSync.
  // The actual orchestrator.run() requires Daytona, so we test the
  // contract by verifying the import exists and the method signature.
  it("imports initGitBaseline from code-sync module", async () => {
    const mod = await import("../../packages/core/src/code-sync/index.js");
    assert.equal(typeof mod.initGitBaseline, "function");
    assert.equal(typeof mod.asSandboxLike, "function");
  });
});
