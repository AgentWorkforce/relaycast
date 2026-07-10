/**
 * Manifest operations — hashing files and serialization.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FileManifest, SerializedManifest } from "./types.js";

/**
 * Compute SHA-256 hashes, sizes, and mtimes for a list of files.
 */
export async function hashFiles(
  rootDir: string,
  files: string[]
): Promise<FileManifest> {
  const absRoot = path.resolve(rootDir);
  const manifest: FileManifest = new Map();

  for (const relPath of files) {
    const fullPath = path.join(absRoot, relPath);
    const content = await readFile(fullPath);
    const fileStat = await stat(fullPath);

    const hash = createHash("sha256").update(content).digest("hex");

    manifest.set(relPath, {
      relativePath: relPath,
      hash,
      size: fileStat.size,
      mtime: fileStat.mtimeMs,
    });
  }

  return manifest;
}

/**
 * Serialize a FileManifest to a JSON-safe structure.
 */
export function serializeManifest(
  manifest: FileManifest,
  root: string
): SerializedManifest {
  return {
    version: 1,
    root,
    entries: Array.from(manifest.values()),
  };
}

/**
 * Deserialize a SerializedManifest back into a FileManifest Map.
 */
export function deserializeManifest(data: SerializedManifest): FileManifest {
  const manifest: FileManifest = new Map();
  for (const entry of data.entries) {
    manifest.set(entry.relativePath, entry);
  }
  return manifest;
}
