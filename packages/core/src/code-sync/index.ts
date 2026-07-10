/**
 * Code-sync module — barrel export + convenience wrapper.
 */

import path from "node:path";
import type { CodeSyncOptions, SyncResult, SerializedManifest, FileManifest } from "./types.js";
import { MANIFEST_FILENAME } from "./types.js";
import { scanDirectory } from "./scanner.js";
import { hashFiles, deserializeManifest } from "./manifest.js";
import { diffManifests } from "./diff.js";
import { syncToSandbox } from "./sync.js";

// Re-export all public API
export * from "./types.js";
export * from "./errors.js";
export { exec, asSandboxLike } from "./sandbox.js";
export { scanDirectory } from "./scanner.js";
export { hashFiles, serializeManifest, deserializeManifest } from "./manifest.js";
export { diffManifests } from "./diff.js";
export { syncToSandbox } from "./sync.js";
export {
  initGitBaseline,
  generatePatch,
  downloadPatch,
  applyPatch,
  downloadAndApplyPatch,
} from "./patch.js";

/**
 * Convenience wrapper: scan -> hash -> fetch remote manifest -> diff -> sync.
 * Does NOT call initGitBaseline — that is the orchestrator's responsibility.
 */
export async function codeSync(options: CodeSyncOptions): Promise<SyncResult> {
  const { rootDir, sandboxDir, sandbox } = options;

  const { files } = await scanDirectory(rootDir);
  const manifest = await hashFiles(rootDir, files);

  let remoteManifest: FileManifest = new Map();
  const manifestRemotePath = path.posix.join(sandboxDir, MANIFEST_FILENAME);
  try {
    const remoteBuf = await sandbox.fs.downloadFile(manifestRemotePath);
    const remoteData: SerializedManifest = JSON.parse(remoteBuf.toString("utf-8"));
    remoteManifest = deserializeManifest(remoteData);
  } catch {
    // No remote manifest — first sync
  }

  const plan = diffManifests(manifest, remoteManifest);

  return syncToSandbox({
    rootDir,
    sandboxDir,
    sandbox,
    manifest,
    plan,
  });
}
