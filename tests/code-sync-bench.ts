/**
 * Benchmark — measures latency of each code-sync phase across different project sizes.
 *
 * Scenarios:
 *   small:  10 files, ~1KB each
 *   medium: 200 files across 20 dirs, ~2KB each
 *   large:  1000 files across 50 dirs, ~5KB each
 *
 * Each scenario measures:
 *   1. scanDirectory
 *   2. hashFiles
 *   3. codeSync (tar create + upload + extract)
 *   4. initGitBaseline
 *   5. generatePatch (after simulated changes)
 *   6. downloadAndApplyPatch
 *
 * Run: npx tsx --env-file=.env tests/code-sync-bench.ts
 */

import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { Daytona } from "@daytonaio/sdk";
import {
  scanDirectory,
  hashFiles,
  codeSync,
  initGitBaseline,
  generatePatch,
  downloadAndApplyPatch,
  asSandboxLike,
} from "../packages/core/src/code-sync/index.js";

const REMOTE_PATH = "/home/daytona/project";

// ── Helpers ──────────────────────────────────────────────────────────

interface Timing {
  phase: string;
  ms: number;
}

async function time<T>(phase: string, fn: () => Promise<T>): Promise<[T, Timing]> {
  const start = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - start);
  return [result, { phase, ms }];
}

function generateContent(sizeBytes: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n ";
  let content = "";
  while (content.length < sizeBytes) {
    content += chars[Math.floor(Math.random() * chars.length)];
  }
  return content;
}

async function createProject(
  fileCount: number,
  dirCount: number,
  fileSizeBytes: number
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-"));

  // Init git repo for patch apply later
  execSync("git init", { cwd: root });
  execSync('git config user.email "bench@test"', { cwd: root });
  execSync('git config user.name "bench"', { cwd: root });

  // Create directories
  const dirs = [""];
  for (let i = 0; i < dirCount; i++) {
    const dir = `src/module-${i}`;
    await mkdir(path.join(root, dir), { recursive: true });
    dirs.push(dir);
  }

  // Distribute files across dirs
  for (let i = 0; i < fileCount; i++) {
    const dir = dirs[i % dirs.length];
    const filePath = path.join(root, dir, `file-${i}.ts`);
    await writeFile(filePath, generateContent(fileSizeBytes));
  }

  execSync("git add -A && git commit -m 'initial'", { cwd: root });
  return root;
}

interface ScenarioConfig {
  name: string;
  fileCount: number;
  dirCount: number;
  fileSizeBytes: number;
  modifyCount: number;
  addCount: number;
  deleteCount: number;
}

const scenarios: ScenarioConfig[] = [
  {
    name: "small (10 files, 1KB)",
    fileCount: 10,
    dirCount: 2,
    fileSizeBytes: 1024,
    modifyCount: 3,
    addCount: 2,
    deleteCount: 1,
  },
  {
    name: "medium (200 files, 2KB)",
    fileCount: 200,
    dirCount: 20,
    fileSizeBytes: 2048,
    modifyCount: 20,
    addCount: 10,
    deleteCount: 5,
  },
  {
    name: "large (1000 files, 5KB)",
    fileCount: 1000,
    dirCount: 50,
    fileSizeBytes: 5120,
    modifyCount: 50,
    addCount: 20,
    deleteCount: 10,
  },
];

// ── Main ─────────────────────────────────────────────────────────────

console.log("Code-Sync Benchmark");
console.log("=".repeat(70));

const daytona = new Daytona();

for (const scenario of scenarios) {
  console.log(`\n--- ${scenario.name} ---`);
  const timings: Timing[] = [];
  let localRoot = "";
  let sandbox: Awaited<ReturnType<Daytona["create"]>> | null = null;

  try {
    // Create local project
    const [root, setupTime] = await time("project-setup", () =>
      createProject(scenario.fileCount, scenario.dirCount, scenario.fileSizeBytes)
    );
    localRoot = root;
    timings.push(setupTime);

    const totalSizeKB = Math.round((scenario.fileCount * scenario.fileSizeBytes) / 1024);
    console.log(`  Project: ${scenario.fileCount} files, ~${totalSizeKB}KB total`);

    // Create sandbox
    const [sb, sandboxTime] = await time("sandbox-create", async () => {
      return daytona.create({ language: "typescript", autoStopInterval: 10 });
    });
    sandbox = sb;
    timings.push(sandboxTime);

    const sbLike = asSandboxLike(sandbox);
    await sandbox.process.executeCommand(`mkdir -p ${REMOTE_PATH}`);

    // Phase 1: scanDirectory (local only)
    const [scanResult, scanTime] = await time("scan", () => scanDirectory(localRoot));
    timings.push(scanTime);

    // Phase 2: hashFiles (local only)
    const [manifest, hashTime] = await time("hash", () => hashFiles(localRoot, scanResult.files));
    timings.push(hashTime);

    // Phase 3: codeSync (tar + upload + extract)
    const [syncResult, syncTime] = await time("code-sync", () =>
      codeSync({ rootDir: localRoot, sandboxDir: REMOTE_PATH, sandbox: sbLike })
    );
    timings.push(syncTime);
    console.log(`  Sync: ${syncResult.uploaded} uploaded, ${syncResult.errors.length} errors`);

    // Phase 4: initGitBaseline
    const [, gitTime] = await time("git-baseline", () =>
      initGitBaseline(sbLike, REMOTE_PATH)
    );
    timings.push(gitTime);

    // Phase 5: Simulate agent changes
    const [, agentTime] = await time("agent-changes", async () => {
      const cmds: string[] = [];

      // Modify files
      for (let i = 0; i < scenario.modifyCount; i++) {
        const dir = i % (scenario.dirCount + 1) === 0 ? "" : `src/module-${i % scenario.dirCount}`;
        const file = `${dir ? dir + "/" : ""}file-${i}.ts`;
        cmds.push(`echo "// modified by agent at $(date)" >> ${REMOTE_PATH}/${file}`);
      }

      // Add new files
      for (let i = 0; i < scenario.addCount; i++) {
        const dir = `src/module-${i % scenario.dirCount}`;
        cmds.push(`echo "// new agent file ${i}" > ${REMOTE_PATH}/${dir}/agent-new-${i}.ts`);
      }

      // Delete files
      for (let i = scenario.fileCount - scenario.deleteCount; i < scenario.fileCount; i++) {
        const dir = i % (scenario.dirCount + 1) === 0 ? "" : `src/module-${i % scenario.dirCount}`;
        const file = `${dir ? dir + "/" : ""}file-${i}.ts`;
        cmds.push(`rm -f ${REMOTE_PATH}/${file}`);
      }

      // Batch all changes in one command for speed
      await sandbox!.process.executeCommand(cmds.join(" && "), undefined, undefined, 30);
    });
    timings.push(agentTime);

    // Phase 6: generatePatch
    const patchPath = "/tmp/changes.patch";
    const [patchResult, patchTime] = await time("generate-patch", () =>
      generatePatch(sbLike, REMOTE_PATH, patchPath)
    );
    timings.push(patchTime);

    // Measure patch size
    const patchBuf = await sandbox.fs.downloadFile(patchPath);
    const patchSizeKB = Math.round(patchBuf.length / 1024 * 10) / 10;

    // Phase 7: downloadAndApplyPatch
    const [applyResult, applyTime] = await time("download-apply-patch", () =>
      downloadAndApplyPatch(sbLike, localRoot, patchPath)
    );
    timings.push(applyTime);

    console.log(`  Patch: ${patchResult.hasChanges ? "yes" : "no"} changes, ${patchSizeKB}KB, applied: ${applyResult.applied}`);

    // ── Results ────────────────────────────────────────────────────────
    const total = timings.reduce((sum, t) => sum + t.ms, 0);
    const userFacing = timings
      .filter((t) => !["project-setup", "sandbox-create", "agent-changes"].includes(t.phase))
      .reduce((sum, t) => sum + t.ms, 0);

    console.log(`\n  ${"Phase".padEnd(25)} ${"Time".padStart(8)}`);
    console.log(`  ${"-".repeat(25)} ${"-".repeat(8)}`);
    for (const t of timings) {
      const marker = ["project-setup", "sandbox-create", "agent-changes"].includes(t.phase) ? " *" : "";
      console.log(`  ${t.phase.padEnd(25)} ${(t.ms + "ms").padStart(8)}${marker}`);
    }
    console.log(`  ${"-".repeat(25)} ${"-".repeat(8)}`);
    console.log(`  ${"TOTAL".padEnd(25)} ${(total + "ms").padStart(8)}`);
    console.log(`  ${"USER-FACING".padEnd(25)} ${(userFacing + "ms").padStart(8)}`);
    console.log(`  (* = setup/infra, not user-facing)`);

  } catch (err) {
    console.error(`  FAILED: ${err}`);
  } finally {
    if (sandbox) {
      try { await daytona.delete(sandbox); } catch {}
    }
    if (localRoot) {
      await rm(localRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

console.log("\n" + "=".repeat(70));
console.log("Benchmark complete");
