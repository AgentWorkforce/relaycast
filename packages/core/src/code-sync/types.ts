/**
 * Shared types, interfaces, and constants for the code-sync module.
 */

// ── Result / Entry types ──────────────────────────────────────────────

export interface ScanResult {
  files: string[];
  root: string;
}

export interface FileEntry {
  relativePath: string;
  hash: string;
  size: number;
  mtime: number;
}

export type FileManifest = Map<string, FileEntry>;

export interface SerializedManifest {
  version: 1;
  root: string;
  entries: Array<{
    relativePath: string;
    hash: string;
    size: number;
    mtime: number;
  }>;
}

export interface SyncPlan {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  stats: {
    toUpload: number;
    toDelete: number;
    unchanged: number;
  };
}

// ── Options types ─────────────────────────────────────────────────────

export interface SyncOptions {
  rootDir: string;
  sandboxDir: string;
  sandbox: SandboxLike;
  manifest: FileManifest;
  plan: SyncPlan;
}

export interface CodeSyncOptions {
  rootDir: string;
  sandboxDir: string;
  sandbox: SandboxLike;
}

export interface SyncResult {
  uploaded: number;
  deleted: number;
  errors: Array<{ file: string; error: string }>;
  manifest: FileManifest;
}

/** Minimal sandbox interface we depend on (subset of Daytona Sandbox). */
export interface SandboxLike {
  fs: {
    uploadFile(source: string | Buffer, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
  };
  process: {
    executeCommand(command: string, cwd?: string): Promise<{ exitCode: number; result: string }>;
  };
}

// ── Constants ─────────────────────────────────────────────────────────

export const MANIFEST_FILENAME = ".code-sync-manifest.json";
export const DEFAULT_PATCH_PATH = "/shared/changes.patch";
export const TMP_TAR_PATH = "/tmp/code-sync.tar.gz";
