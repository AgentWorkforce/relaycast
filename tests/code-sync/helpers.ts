/**
 * Shared test helpers for code-sync tests.
 */

import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { FileManifest, SandboxLike } from "../../packages/core/src/code-sync/index.js";

export async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "code-sync-test-"));
}

export async function writeFileAt(root: string, relPath: string, content: string): Promise<void> {
  const full = path.join(root, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function makeManifest(entries: Array<[string, string]>): FileManifest {
  const m: FileManifest = new Map();
  for (const [relPath, hash] of entries) {
    m.set(relPath, { relativePath: relPath, hash, size: 0, mtime: 0 });
  }
  return m;
}

export function createMockSandbox() {
  const uploaded: Array<{ source: string | Buffer; remotePath: string }> = [];
  const commands: Array<{ command: string; cwd?: string }> = [];

  const sandbox: SandboxLike = {
    fs: {
      async uploadFile(source: string | Buffer, remotePath: string) {
        uploaded.push({ source, remotePath });
      },
      async downloadFile(_remotePath: string): Promise<Buffer> {
        throw new Error("Not found");
      },
    },
    process: {
      async executeCommand(command: string, cwd?: string) {
        commands.push({ command, cwd });
        return { exitCode: 0, result: "" };
      },
    },
  };

  return { sandbox, uploaded, commands };
}
