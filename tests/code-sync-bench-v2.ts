/**
 * Benchmark v2 — compares tar, bulk uploadFiles, and rsync-over-SSH.
 *
 * Run: npx tsx --env-file=.env tests/code-sync-bench-v2.ts
 */

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import { Daytona } from "@daytonaio/sdk";
import { asSandboxLike, scanDirectory } from "../packages/core/src/code-sync/index.js";

const REMOTE_PATH = "/home/daytona/project";

// ── Helpers ──────────────────────────────────────────────────────────

async function time<T>(label: string, fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - start)];
}

function generateContent(sizeBytes: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789\n ";
  let content = "";
  while (content.length < sizeBytes) content += chars[Math.floor(Math.random() * chars.length)];
  return content;
}

async function createProject(fileCount: number, dirCount: number, fileSizeBytes: number): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench2-"));
  const dirs = [""];
  for (let i = 0; i < dirCount; i++) {
    const dir = `src/mod-${i}`;
    await mkdir(path.join(root, dir), { recursive: true });
    dirs.push(dir);
  }
  for (let i = 0; i < fileCount; i++) {
    const dir = dirs[i % dirs.length];
    await writeFile(path.join(root, dir, `file-${i}.ts`), generateContent(fileSizeBytes));
  }
  return root;
}

type SandboxType = Awaited<ReturnType<Daytona["create"]>>;

// ── Strategy: tar.gz ─────────────────────────────────────────────────

async function stratTar(sandbox: SandboxType, localRoot: string, files: string[]): Promise<number> {
  const [, ms] = await time("tar", async () => {
    const tarStream = tar.create({ gzip: true, cwd: localRoot, portable: true }, files);
    const chunks: Buffer[] = [];
    for await (const chunk of tarStream) chunks.push(Buffer.from(chunk as Uint8Array));
    const tarBuffer = Buffer.concat(chunks);
    await sandbox.fs.uploadFile(tarBuffer, "/tmp/bench.tar.gz");
    await sandbox.process.executeCommand(`tar xzf /tmp/bench.tar.gz -C ${REMOTE_PATH}`, undefined, undefined, 60);
  });
  return ms;
}

// ── Strategy: bulk uploadFiles ───────────────────────────────────────

async function stratBulkUpload(sandbox: SandboxType, localRoot: string, files: string[]): Promise<number> {
  // Create dirs first
  const dirs = new Set(files.map(f => path.dirname(f)).filter(d => d !== "."));
  if (dirs.size > 0) {
    await sandbox.process.executeCommand(
      [...dirs].map(d => `mkdir -p ${REMOTE_PATH}/${d}`).join(" && "),
      undefined, undefined, 30
    );
  }

  const [, ms] = await time("bulk", async () => {
    // Build FileUpload array using local file paths (streamed, not buffered)
    const uploads = files.map(f => ({
      source: path.join(localRoot, f),
      destination: `${REMOTE_PATH}/${f}`,
    }));
    await sandbox.fs.uploadFiles(uploads);
  });
  return ms;
}

// ── Strategy: rsync over SSH ─────────────────────────────────────────

async function stratRsync(sandbox: SandboxType, localRoot: string): Promise<{ ms: number; sshWorks: boolean }> {
  try {
    const sshAccess = await sandbox.createSshAccess(10);
    console.log(`    SSH command: ${sshAccess.sshCommand}`);

    // Parse the SSH command to extract host/port/user info
    // sshCommand format is typically: ssh -o StrictHostKeyChecking=no -p PORT USER@HOST
    const sshCmd = sshAccess.sshCommand;

    const [, ms] = await time("rsync", async () => {
      // Use rsync over the SSH connection
      // -a = archive, -z = compress, --delete = remove extra files
      const rsyncCmd = `rsync -azq --delete -e "${sshCmd.replace(/^ssh /, "ssh ")
        .replace(/ [^ ]+@[^ ]+$/, "")}" ${localRoot}/ ${sshCmd.match(/[^ ]+@[^ ]+$/)?.[0]}:${REMOTE_PATH}/`;

      // Actually the sshCommand includes the full "ssh ... user@host" — we need to split it
      // Let's try a different approach: extract parts
      const parts = sshCmd.split(" ");
      const userHost = parts[parts.length - 1]; // user@host
      const sshOpts = parts.slice(1, -1).join(" "); // everything between 'ssh' and 'user@host'

      const fullCmd = `rsync -azq --delete -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${sshOpts}" "${localRoot}/" "${userHost}:${REMOTE_PATH}/"`;
      console.log(`    rsync cmd: ${fullCmd.slice(0, 120)}...`);

      execSync(fullCmd, { timeout: 120_000, encoding: "utf-8" });
    });

    await sandbox.revokeSshAccess(sshAccess.token);
    return { ms, sshWorks: true };
  } catch (err: any) {
    console.log(`    rsync failed: ${err.message?.slice(0, 200)}`);
    return { ms: -1, sshWorks: false };
  }
}

// ── Main ─────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  fileCount: number;
  dirCount: number;
  fileSizeBytes: number;
}

const scenarios: Scenario[] = [
  { name: "small (10 files, 1KB)", fileCount: 10, dirCount: 2, fileSizeBytes: 1024 },
  { name: "medium (200 files, 2KB)", fileCount: 200, dirCount: 20, fileSizeBytes: 2048 },
  { name: "large (1000 files, 5KB)", fileCount: 1000, dirCount: 50, fileSizeBytes: 5120 },
];

console.log("Code-Sync Strategy Benchmark v2 (tar vs bulk API vs rsync)");
console.log("=".repeat(80));

const daytona = new Daytona();

for (const sc of scenarios) {
  console.log(`\n--- ${sc.name} ---`);
  let localRoot = "";
  let sandbox: SandboxType | null = null;

  try {
    localRoot = await createProject(sc.fileCount, sc.dirCount, sc.fileSizeBytes);
    const { files } = await scanDirectory(localRoot);
    const totalKB = Math.round(sc.fileCount * sc.fileSizeBytes / 1024);
    console.log(`  ${files.length} files, ~${totalKB}KB\n`);

    sandbox = await daytona.create({ language: "typescript", autoStopInterval: 10 });
    console.log(`  Sandbox: ${sandbox.id}\n`);

    // ── tar.gz ────────────────────────────────────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const tarMs = await stratTar(sandbox, localRoot, files);
    console.log(`  [tar.gz]         ${String(tarMs).padStart(6)}ms`);

    // ── bulk uploadFiles ──────────────────────────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const bulkMs = await stratBulkUpload(sandbox, localRoot, files);
    console.log(`  [bulk upload]    ${String(bulkMs).padStart(6)}ms`);

    // ── rsync over SSH ────────────────────────────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    console.log(`  [rsync-ssh]      ...`);
    const rsyncResult = await stratRsync(sandbox, localRoot);
    if (rsyncResult.sshWorks) {
      console.log(`  [rsync-ssh]      ${String(rsyncResult.ms).padStart(6)}ms`);
    } else {
      console.log(`  [rsync-ssh]      UNAVAILABLE`);
    }

    // ── Incremental rsync (if SSH works) ─────────────────────────────
    if (rsyncResult.sshWorks) {
      // Modify 5% of files
      const changeCount = Math.max(1, Math.floor(files.length * 0.05));
      for (let i = 0; i < changeCount; i++) {
        await writeFile(path.join(localRoot, files[i]), generateContent(sc.fileSizeBytes));
      }
      const rsyncIncr = await stratRsync(sandbox, localRoot);
      console.log(`  [rsync incr 5%]  ${String(rsyncIncr.ms).padStart(6)}ms  (${changeCount} files changed)`);
    }

    // ── Summary ────────────────────────────────────────────────────
    const all = [
      { name: "tar.gz", ms: tarMs },
      { name: "bulk upload", ms: bulkMs },
      ...(rsyncResult.sshWorks ? [{ name: "rsync-ssh", ms: rsyncResult.ms }] : []),
    ];
    const winner = all.reduce((a, b) => a.ms < b.ms ? a : b);
    console.log(`\n  Winner: ${winner.name} (${winner.ms}ms)`);

  } catch (err) {
    console.error(`  FAILED: ${err}`);
  } finally {
    if (sandbox) { try { await daytona.delete(sandbox); } catch {} }
    if (localRoot) await rm(localRoot, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("\n" + "=".repeat(80));
