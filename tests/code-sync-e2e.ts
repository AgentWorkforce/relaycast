/**
 * End-to-end test — exercises the full code-sync pipeline against a real Daytona sandbox.
 *
 * Flow:
 *   1. Create a temp local project with known files
 *   2. Create a Daytona sandbox
 *   3. codeSync: tar upload local files to sandbox
 *   4. initGitBaseline: commit baseline on sandbox
 *   5. Simulate agent work: modify/add/delete files on sandbox
 *   6. generatePatch: capture agent changes as a git patch
 *   7. downloadAndApplyPatch: download patch and apply locally
 *   8. Verify local files match expected state
 *
 * Requires DAYTONA_API_KEY in environment.
 * Run: npx tsx --env-file=.env tests/code-sync-e2e.ts
 */

import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Daytona } from "@daytonaio/sdk";
import {
  codeSync,
  initGitBaseline,
  generatePatch,
  downloadAndApplyPatch,
  asSandboxLike,
} from "../packages/core/src/code-sync/index.js";

const REMOTE_PATH = "/home/daytona/project";

// ── Helpers ──────────────────────────────────────────────────────────

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  log("ASSERT", `PASS — ${msg}`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const localRoot = await mkdtemp(path.join(os.tmpdir(), "code-sync-e2e-"));
let sandbox: Awaited<ReturnType<Daytona["create"]>> | null = null;

try {
  // ── Step 1: Create local project with known files ──────────────────
  log("SETUP", `Local project: ${localRoot}`);

  // Init a git repo so git apply works later
  execSync("git init", { cwd: localRoot });
  execSync('git config user.email "e2e@test"', { cwd: localRoot });
  execSync('git config user.name "e2e"', { cwd: localRoot });

  await writeFile(path.join(localRoot, "README.md"), "# E2E Test Project\n");
  await writeFile(path.join(localRoot, "src/index.ts"), "export const hello = 'world';\n", {
    // mkdir -p equivalent
  }).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(localRoot, "src"), { recursive: true });
    await writeFile(path.join(localRoot, "src/index.ts"), "export const hello = 'world';\n");
  });
  await writeFile(path.join(localRoot, "config.json"), '{"version": 1}\n');

  execSync("git add -A && git commit -m 'initial'", { cwd: localRoot });
  log("SETUP", "Created 3 files: README.md, src/index.ts, config.json");

  // ── Step 2: Create Daytona sandbox ─────────────────────────────────
  log("DAYTONA", "Creating sandbox...");
  const daytona = new Daytona();
  sandbox = await daytona.create({
    language: "typescript",
    autoStopInterval: 10,
  });
  log("DAYTONA", `Sandbox created: ${sandbox.id}`);

  const sbLike = asSandboxLike(sandbox);

  // Create remote project directory
  await sandbox.process.executeCommand(`mkdir -p ${REMOTE_PATH}`);

  // ── Step 3: codeSync — tar upload ──────────────────────────────────
  log("CODESYNC", "Syncing local files to sandbox via tar...");
  const syncResult = await codeSync({
    rootDir: localRoot,
    sandboxDir: REMOTE_PATH,
    sandbox: sbLike,
  });
  log("CODESYNC", `Uploaded: ${syncResult.uploaded}, Deleted: ${syncResult.deleted}, Errors: ${syncResult.errors.length}`);
  assert(syncResult.errors.length === 0, "codeSync should have no errors");
  assert(syncResult.uploaded > 0, "codeSync should upload files");

  // Verify files landed on sandbox
  const lsResult = await sandbox.process.executeCommand(`ls -la ${REMOTE_PATH}`, undefined, undefined, 10);
  log("VERIFY", `Remote files:\n${lsResult.result}`);
  assert(lsResult.result.includes("README.md"), "README.md should exist on sandbox");

  const catResult = await sandbox.process.executeCommand(`cat ${REMOTE_PATH}/src/index.ts`, undefined, undefined, 10);
  assert(catResult.result.includes("hello"), "src/index.ts content should be correct on sandbox");

  // ── Step 4: initGitBaseline ────────────────────────────────────────
  log("GIT", "Initializing git baseline on sandbox...");
  await initGitBaseline(sbLike, REMOTE_PATH);
  log("GIT", "Baseline committed");

  // Verify git status is clean
  const statusResult = await sandbox.process.executeCommand("git status --short", REMOTE_PATH, undefined, 10);
  assert(statusResult.result.trim() === "", "git status should be clean after baseline");

  // ── Step 5: Simulate agent work on sandbox ─────────────────────────
  log("AGENT", "Simulating agent changes on sandbox...");

  // Modify an existing file
  await sandbox.process.executeCommand(
    `echo "export const hello = 'modified by agent';" > ${REMOTE_PATH}/src/index.ts`,
    undefined, undefined, 10
  );

  // Add a new file
  await sandbox.process.executeCommand(
    `echo "// generated by agent" > ${REMOTE_PATH}/src/agent-output.ts`,
    undefined, undefined, 10
  );

  // Delete a file
  await sandbox.process.executeCommand(
    `rm ${REMOTE_PATH}/config.json`,
    undefined, undefined, 10
  );

  log("AGENT", "Modified src/index.ts, added src/agent-output.ts, deleted config.json");

  // ── Step 6: generatePatch ──────────────────────────────────────────
  log("PATCH", "Generating git patch from agent changes...");
  const patchPath = "/tmp/changes.patch";
  const patchResult = await generatePatch(sbLike, REMOTE_PATH, patchPath);
  log("PATCH", `hasChanges: ${patchResult.hasChanges}, patchPath: ${patchResult.patchPath}`);
  assert(patchResult.hasChanges === true, "patch should detect changes");

  // Peek at patch content
  const patchBuf = await sandbox.fs.downloadFile(patchResult.patchPath);
  const patchContent = patchBuf.toString("utf-8");
  log("PATCH", `Patch size: ${patchContent.length} bytes`);
  log("PATCH", `Patch preview:\n${patchContent.slice(0, 500)}`);
  assert(patchContent.includes("modified by agent"), "patch should contain the modification");
  assert(patchContent.includes("agent-output.ts"), "patch should contain the new file");
  assert(patchContent.includes("config.json"), "patch should contain the deletion");

  // ── Step 7: downloadAndApplyPatch ──────────────────────────────────
  log("APPLY", "Downloading and applying patch locally...");
  const applyResult = await downloadAndApplyPatch(sbLike, localRoot, patchResult.patchPath);
  log("APPLY", `applied: ${applyResult.applied}, output: ${applyResult.output}`);
  assert(applyResult.applied === true, "patch should apply successfully");

  // ── Step 8: Verify local state ─────────────────────────────────────
  log("VERIFY", "Checking local files match expected state...");

  // Modified file
  const indexContent = await readFile(path.join(localRoot, "src/index.ts"), "utf-8");
  assert(indexContent.includes("modified by agent"), "src/index.ts should contain agent modification");

  // New file
  const agentFileExists = await fileExists(path.join(localRoot, "src/agent-output.ts"));
  assert(agentFileExists, "src/agent-output.ts should exist locally");
  const agentContent = await readFile(path.join(localRoot, "src/agent-output.ts"), "utf-8");
  assert(agentContent.includes("generated by agent"), "src/agent-output.ts should have correct content");

  // Deleted file
  const configExists = await fileExists(path.join(localRoot, "config.json"));
  assert(!configExists, "config.json should be deleted locally");

  // Untouched file
  const readmeContent = await readFile(path.join(localRoot, "README.md"), "utf-8");
  assert(readmeContent.includes("E2E Test Project"), "README.md should be untouched");

  // ── Done ───────────────────────────────────────────────────────────
  console.log("\n========================================");
  console.log("  ALL E2E TESTS PASSED");
  console.log("========================================\n");

} catch (err) {
  console.error("\nE2E TEST FAILED:", err);
  process.exit(1);
} finally {
  // Cleanup
  if (sandbox) {
    log("CLEANUP", `Removing sandbox ${sandbox.id}...`);
    try {
      const daytona = new Daytona();
      await daytona.delete(sandbox);
      log("CLEANUP", "Sandbox removed");
    } catch (e) {
      log("CLEANUP", `Failed to remove sandbox: ${e}`);
    }
  }
  await rm(localRoot, { recursive: true, force: true }).catch(() => {});
  log("CLEANUP", "Local temp dir removed");
}
