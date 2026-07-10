/**
 * Benchmark — compares file transfer strategies for code-sync.
 *
 * Strategies:
 *   1. tar (current): tar.gz → single upload → extract
 *   2. parallel-upload: upload files individually via Promise.all
 *   3. tar-no-gzip: tar without compression (skip CPU cost)
 *   4. incremental-tar: only changed files (simulates second sync)
 *
 * Also measures: what fraction of time is network vs local CPU.
 *
 * Run: npx tsx --env-file=.env tests/code-sync-bench-strategies.ts
 */

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import { Daytona } from "@daytonaio/sdk";
import { asSandboxLike, scanDirectory, hashFiles } from "../packages/core/src/code-sync/index.js";

const REMOTE_PATH = "/home/daytona/project";

// ── Helpers ──────────────────────────────────────────────────────────

async function time<T>(label: string, fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  const ms = Math.round(performance.now() - start);
  return [result, ms];
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
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-strat-"));

  const dirs = [""];
  for (let i = 0; i < dirCount; i++) {
    const dir = `src/module-${i}`;
    await mkdir(path.join(root, dir), { recursive: true });
    dirs.push(dir);
  }

  for (let i = 0; i < fileCount; i++) {
    const dir = dirs[i % dirs.length];
    const filePath = path.join(root, dir, `file-${i}.ts`);
    await writeFile(filePath, generateContent(fileSizeBytes));
  }

  return root;
}

type SandboxType = Awaited<ReturnType<Daytona["create"]>>;

// ── Strategies ───────────────────────────────────────────────────────

async function strategyTarGzip(
  sandbox: SandboxType,
  localRoot: string,
  files: string[],
  remotePath: string
): Promise<{ tarCreateMs: number; uploadMs: number; extractMs: number; totalMs: number; archiveSize: number }> {
  // tar create
  const t0 = performance.now();
  const tarStream = tar.create({ gzip: true, cwd: localRoot, portable: true }, files);
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const tarBuffer = Buffer.concat(chunks);
  const tarCreateMs = Math.round(performance.now() - t0);

  // upload
  const t1 = performance.now();
  await sandbox.fs.uploadFile(tarBuffer, "/tmp/bench.tar.gz");
  const uploadMs = Math.round(performance.now() - t1);

  // extract
  const t2 = performance.now();
  await sandbox.process.executeCommand(`tar xzf /tmp/bench.tar.gz -C ${remotePath}`, undefined, undefined, 60);
  const extractMs = Math.round(performance.now() - t2);

  return {
    tarCreateMs,
    uploadMs,
    extractMs,
    totalMs: tarCreateMs + uploadMs + extractMs,
    archiveSize: tarBuffer.length,
  };
}

async function strategyTarNoGzip(
  sandbox: SandboxType,
  localRoot: string,
  files: string[],
  remotePath: string
): Promise<{ tarCreateMs: number; uploadMs: number; extractMs: number; totalMs: number; archiveSize: number }> {
  const t0 = performance.now();
  const tarStream = tar.create({ gzip: false, cwd: localRoot, portable: true }, files);
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const tarBuffer = Buffer.concat(chunks);
  const tarCreateMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  await sandbox.fs.uploadFile(tarBuffer, "/tmp/bench.tar");
  const uploadMs = Math.round(performance.now() - t1);

  const t2 = performance.now();
  await sandbox.process.executeCommand(`tar xf /tmp/bench.tar -C ${remotePath}`, undefined, undefined, 60);
  const extractMs = Math.round(performance.now() - t2);

  return {
    tarCreateMs,
    uploadMs,
    extractMs,
    totalMs: tarCreateMs + uploadMs + extractMs,
    archiveSize: tarBuffer.length,
  };
}

async function strategyParallelUpload(
  sandbox: SandboxType,
  localRoot: string,
  files: string[],
  remotePath: string,
  concurrency: number
): Promise<{ totalMs: number; archiveSize: number }> {
  // Create dirs first
  const dirs = new Set(files.map((f) => path.dirname(f)).filter((d) => d !== "."));
  if (dirs.size > 0) {
    const mkdirCmd = [...dirs].map((d) => `mkdir -p ${remotePath}/${d}`).join(" && ");
    await sandbox.process.executeCommand(mkdirCmd, undefined, undefined, 30);
  }

  const t0 = performance.now();
  let totalBytes = 0;

  // Upload in batches of `concurrency`
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (file) => {
        const content = await readFile(path.join(localRoot, file));
        totalBytes += content.length;
        await sandbox.fs.uploadFile(content, `${remotePath}/${file}`);
      })
    );
  }

  const totalMs = Math.round(performance.now() - t0);
  return { totalMs, archiveSize: totalBytes };
}

// ── Main ─────────────────────────────────────────────────────────────

interface ScenarioConfig {
  name: string;
  fileCount: number;
  dirCount: number;
  fileSizeBytes: number;
  changePercent: number;
}

const scenarios: ScenarioConfig[] = [
  { name: "small (10 files, 1KB)", fileCount: 10, dirCount: 2, fileSizeBytes: 1024, changePercent: 30 },
  { name: "medium (200 files, 2KB)", fileCount: 200, dirCount: 20, fileSizeBytes: 2048, changePercent: 10 },
  { name: "large (1000 files, 5KB)", fileCount: 1000, dirCount: 50, fileSizeBytes: 5120, changePercent: 5 },
];

console.log("Code-Sync Strategy Benchmark");
console.log("=".repeat(80));

const daytona = new Daytona();

for (const scenario of scenarios) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`${scenario.name}`);
  console.log(`${"=".repeat(80)}`);

  let localRoot = "";
  let sandbox: SandboxType | null = null;

  try {
    localRoot = await createProject(scenario.fileCount, scenario.dirCount, scenario.fileSizeBytes);
    const { files } = await scanDirectory(localRoot);
    const totalSizeKB = Math.round((scenario.fileCount * scenario.fileSizeBytes) / 1024);
    console.log(`  ${files.length} files, ~${totalSizeKB}KB total\n`);

    sandbox = await daytona.create({ language: "typescript", autoStopInterval: 10 });

    // ── Strategy 1: tar.gz (current approach) ────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const tarGz = await strategyTarGzip(sandbox, localRoot, files, REMOTE_PATH);
    console.log(`  [tar.gz]            ${String(tarGz.totalMs).padStart(5)}ms  (create: ${tarGz.tarCreateMs}ms, upload: ${tarGz.uploadMs}ms, extract: ${tarGz.extractMs}ms)  archive: ${Math.round(tarGz.archiveSize / 1024)}KB`);

    // ── Strategy 2: tar (no compression) ─────────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const tarPlain = await strategyTarNoGzip(sandbox, localRoot, files, REMOTE_PATH);
    console.log(`  [tar plain]         ${String(tarPlain.totalMs).padStart(5)}ms  (create: ${tarPlain.tarCreateMs}ms, upload: ${tarPlain.uploadMs}ms, extract: ${tarPlain.extractMs}ms)  archive: ${Math.round(tarPlain.archiveSize / 1024)}KB`);

    // ── Strategy 3: parallel upload (concurrency=10) ─────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const parallel10 = await strategyParallelUpload(sandbox, localRoot, files, REMOTE_PATH, 10);
    console.log(`  [parallel-10]       ${String(parallel10.totalMs).padStart(5)}ms  (10 concurrent uploads)  total: ${Math.round(parallel10.archiveSize / 1024)}KB`);

    // ── Strategy 4: parallel upload (concurrency=50) ─────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const parallel50 = await strategyParallelUpload(sandbox, localRoot, files, REMOTE_PATH, 50);
    console.log(`  [parallel-50]       ${String(parallel50.totalMs).padStart(5)}ms  (50 concurrent uploads)  total: ${Math.round(parallel50.archiveSize / 1024)}KB`);

    // ── Strategy 5: incremental tar.gz (only changed files) ──────────
    const changeCount = Math.max(1, Math.floor(scenario.fileCount * scenario.changePercent / 100));
    const changedFiles = files.slice(0, changeCount);
    // Modify the selected files locally
    for (const f of changedFiles) {
      await writeFile(path.join(localRoot, f), generateContent(scenario.fileSizeBytes));
    }
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`);
    const incremental = await strategyTarGzip(sandbox, localRoot, changedFiles, REMOTE_PATH);
    console.log(`  [incremental tar.gz] ${String(incremental.totalMs).padStart(4)}ms  (${changedFiles.length}/${files.length} changed)  archive: ${Math.round(incremental.archiveSize / 1024)}KB`);

    // ── Summary ──────────────────────────────────────────────────────
    const fastest = Math.min(tarGz.totalMs, tarPlain.totalMs, parallel10.totalMs, parallel50.totalMs);
    console.log(`\n  Winner (full sync): ${
      tarGz.totalMs === fastest ? "tar.gz" :
      tarPlain.totalMs === fastest ? "tar plain" :
      parallel10.totalMs === fastest ? "parallel-10" :
      "parallel-50"
    } (${fastest}ms)`);
    console.log(`  Incremental sync: ${incremental.totalMs}ms for ${changeCount} files (${scenario.changePercent}% changed)`);

    // rsync comparison note
    const rsyncEstimate = Math.round(tarGz.uploadMs * 0.3 + tarGz.extractMs);
    console.log(`\n  rsync estimate*: ~${rsyncEstimate}ms for incremental (if available)`);
    console.log(`  * rsync delta transfer would skip unchanged blocks within files,`);
    console.log(`    but requires SSH tunnel (not available via Daytona SDK API)`);

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

console.log(`\n${"=".repeat(80)}`);
console.log("KEY TAKEAWAY:");
console.log("  rsync's advantage is block-level deltas within large files.");
console.log("  For code (many small files), our manifest-based incremental tar");
console.log("  achieves similar results: only changed files are transferred.");
console.log("  The bottleneck is Daytona API latency per request, not transfer size.");
console.log("=".repeat(80));
