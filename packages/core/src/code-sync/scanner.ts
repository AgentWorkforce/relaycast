/**
 * File scanner — recursively walks a directory respecting .gitignore rules.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import type { ScanResult } from "./types.js";

/**
 * Recursively scan a directory, returning sorted relative file paths.
 * Excludes `.git/`, `node_modules/`, and files matching `.gitignore`.
 */
export async function scanDirectory(rootDir: string): Promise<ScanResult> {
  const absRoot = path.resolve(rootDir);

  const ig = ignore();
  ig.add([".git", "node_modules"]);
  try {
    const gitignoreContent = await readFile(
      path.join(absRoot, ".gitignore"),
      "utf-8"
    );
    ig.add(gitignoreContent);
  } catch {
    // No .gitignore — that's fine
  }

  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(absRoot, fullPath).split(path.sep).join("/");

      if (ig.ignores(relativePath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await walk(absRoot);
  files.sort();

  return { files, root: absRoot };
}
