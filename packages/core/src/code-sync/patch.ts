/**
 * Git patch operations — baseline init, patch generation, download, and apply.
 */

import { execSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SandboxLike } from "./types.js";
import { DEFAULT_PATCH_PATH } from "./types.js";
import { exec } from "./sandbox.js";

/**
 * Initialize a git repo on the sandbox and commit the current state as baseline.
 */
export async function initGitBaseline(
  sandbox: SandboxLike,
  sandboxDir: string
): Promise<void> {
  await exec(sandbox, "git init", sandboxDir);
  await exec(
    sandbox,
    'git config user.email "code-sync@agent" && git config user.name "code-sync"',
    sandboxDir
  );
  await exec(
    sandbox,
    'git add -A && git commit -m "baseline"',
    sandboxDir
  );
}

/**
 * Generate a git patch from all changes made since the baseline commit.
 */
export async function generatePatch(
  sandbox: SandboxLike,
  sandboxDir: string,
  outputPath: string = DEFAULT_PATCH_PATH
): Promise<{ patchPath: string; hasChanges: boolean }> {
  await exec(sandbox, "git add -A", sandboxDir);
  // Bypass exec() — redirect always exits 0, and we check content separately
  await sandbox.process.executeCommand(
    `git diff --cached HEAD > "${outputPath}"`,
    sandboxDir
  );
  // Bypass exec() — this compound command always exits 0 (echo in both branches)
  const check = await sandbox.process.executeCommand(
    `test -s "${outputPath}" && echo "HAS_CHANGES" || echo "NO_CHANGES"`
  );
  const hasChanges = check.result.trim() === "HAS_CHANGES";
  return { patchPath: outputPath, hasChanges };
}

/**
 * Download a patch file from the sandbox.
 */
export async function downloadPatch(
  sandbox: SandboxLike,
  patchPath: string = DEFAULT_PATCH_PATH
): Promise<string> {
  const patchBuffer = await sandbox.fs.downloadFile(patchPath);
  return patchBuffer.toString("utf-8");
}

/**
 * Apply a patch string to a local directory via `git apply`.
 */
export async function applyPatch(
  localRootDir: string,
  patchContent: string
): Promise<{ applied: boolean; output: string }> {
  if (!patchContent.trim()) {
    return { applied: false, output: "No changes in patch" };
  }

  const tmpPatch = path.join(os.tmpdir(), `code-sync-${Date.now()}.patch`);
  await writeFile(tmpPatch, patchContent);

  try {
    const output = execSync(`git apply "${tmpPatch}"`, {
      cwd: path.resolve(localRootDir),
      encoding: "utf-8",
    });
    return { applied: true, output: output || "Patch applied successfully" };
  } catch (err: any) {
    return { applied: false, output: err.message ?? String(err) };
  } finally {
    await rm(tmpPatch).catch(() => {});
  }
}

/**
 * Download a patch from the sandbox and apply it locally.
 * Thin wrapper composing downloadPatch + applyPatch.
 */
export async function downloadAndApplyPatch(
  sandbox: SandboxLike,
  localRootDir: string,
  patchPath: string = DEFAULT_PATCH_PATH
): Promise<{ applied: boolean; output: string }> {
  const patchContent = await downloadPatch(sandbox, patchPath);
  return applyPatch(localRootDir, patchContent);
}
