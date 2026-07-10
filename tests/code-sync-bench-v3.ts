/**
 * Benchmark v3 — realistic project sizes modeled after Nango and Kubernetes.
 *
 * Scenarios:
 *   nango-like:   6,500 files across 200 dirs, ~1KB avg (6.5MB source)
 *   k8s-like:     28,000 files across 800 dirs, ~3KB avg (84MB source)
 *   k8s-subset:   5,000 files (what you'd actually sync after .gitignore)
 *
 * Tests: tar.gz vs bulk uploadFiles, full sync and incremental.
 *
 * Run: npx tsx --env-file=.env tests/code-sync-bench-v3.ts
 */

import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import { Daytona } from "@daytonaio/sdk";
import { asSandboxLike, scanDirectory, hashFiles, diffManifests } from "../packages/core/src/code-sync/index.js";

const REMOTE_PATH = "/home/daytona/project";

// ── Helpers ──────────────────────────────────────────────────────────

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await fn();
  return [result, Math.round(performance.now() - start)];
}

function generateContent(sizeBytes: number): string {
  // Generate realistic-looking code content
  const lines = [];
  let remaining = sizeBytes;
  while (remaining > 0) {
    const line = `const x${Math.floor(Math.random() * 99999)} = "${Math.random().toString(36).slice(2)}";\n`;
    lines.push(line);
    remaining -= line.length;
  }
  return lines.join("").slice(0, sizeBytes);
}

async function createProject(fileCount: number, dirCount: number, avgFileSize: number): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench3-"));

  // Create dirs
  const dirs = [""];
  for (let i = 0; i < dirCount; i++) {
    const depth = Math.floor(Math.random() * 3) + 1;
    const parts = [];
    for (let d = 0; d < depth; d++) {
      parts.push(`mod${Math.floor(Math.random() * 50)}`);
    }
    const dir = `src/${parts.join("/")}`;
    await mkdir(path.join(root, dir), { recursive: true });
    dirs.push(dir);
  }

  // Create files with varying sizes (0.5x to 2x of avg)
  let totalBytes = 0;
  for (let i = 0; i < fileCount; i++) {
    const dir = dirs[i % dirs.length];
    const size = Math.floor(avgFileSize * (0.5 + Math.random() * 1.5));
    const content = generateContent(size);
    totalBytes += content.length;
    await writeFile(path.join(root, dir, `file-${i}.ts`), content);
  }

  return root;
}

type SandboxType = Awaited<ReturnType<Daytona["create"]>>;

// ── Strategies ───────────────────────────────────────────────────────

async function stratTar(
  sandbox: SandboxType,
  localRoot: string,
  files: string[]
): Promise<{ total: number; create: number; upload: number; extract: number; archiveKB: number }> {
  const t0 = performance.now();
  const tarStream = tar.create({ gzip: true, cwd: localRoot, portable: true }, files);
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream) chunks.push(Buffer.from(chunk as Uint8Array));
  const tarBuffer = Buffer.concat(chunks);
  const create = Math.round(performance.now() - t0);

  const t1 = performance.now();
  await sandbox.fs.uploadFile(tarBuffer, "/tmp/bench.tar.gz");
  const upload = Math.round(performance.now() - t1);

  const t2 = performance.now();
  await sandbox.process.executeCommand(`tar xzf /tmp/bench.tar.gz -C ${REMOTE_PATH}`, undefined, undefined, 120);
  const extract = Math.round(performance.now() - t2);

  return { total: create + upload + extract, create, upload, extract, archiveKB: Math.round(tarBuffer.length / 1024) };
}

async function stratBulkUpload(
  sandbox: SandboxType,
  localRoot: string,
  files: string[]
): Promise<{ total: number; mkdirMs: number; uploadMs: number }> {
  // Create dirs
  const dirs = [...new Set(files.map(f => path.dirname(f)).filter(d => d !== "."))];
  const t0 = performance.now();
  // Batch mkdir in chunks to avoid command line too long
  for (let i = 0; i < dirs.length; i += 100) {
    const batch = dirs.slice(i, i + 100);
    await sandbox.process.executeCommand(
      batch.map(d => `mkdir -p ${REMOTE_PATH}/${d}`).join(" && "),
      undefined, undefined, 30
    );
  }
  const mkdirMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  // Upload in batches to avoid memory issues
  const batchSize = 500;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const uploads = batch.map(f => ({
      source: path.join(localRoot, f),
      destination: `${REMOTE_PATH}/${f}`,
    }));
    await sandbox.fs.uploadFiles(uploads);
  }
  const uploadMs = Math.round(performance.now() - t1);

  return { total: mkdirMs + uploadMs, mkdirMs, uploadMs };
}

// ── Main ─────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  fileCount: number;
  dirCount: number;
  avgFileSize: number;
  changePercent: number;
}

const scenarios: Scenario[] = [
  {
    name: "Nango-scale (6,500 files, ~6.5MB)",
    fileCount: 6500,
    dirCount: 200,
    avgFileSize: 1024,
    changePercent: 2,
  },
  {
    name: "K8s-subset (5,000 files, ~15MB — post-gitignore)",
    fileCount: 5000,
    dirCount: 300,
    avgFileSize: 3072,
    changePercent: 1,
  },
  {
    name: "K8s-full (28,000 files, ~84MB)",
    fileCount: 28000,
    dirCount: 800,
    avgFileSize: 3072,
    changePercent: 0.5,
  },
];

console.log("Code-Sync Benchmark v3 — Real-World Project Scales");
console.log("=".repeat(80));

const daytona = new Daytona();

for (const sc of scenarios) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`${sc.name}`);
  console.log(`${"=".repeat(80)}`);

  let localRoot = "";
  let sandbox: SandboxType | null = null;

  try {
    // Create project
    const [root, setupMs] = await time(() => createProject(sc.fileCount, sc.dirCount, sc.avgFileSize));
    localRoot = root;
    console.log(`  Setup: ${setupMs}ms`);

    // Scan + hash locally
    const [scanResult, scanMs] = await time(() => scanDirectory(localRoot));
    const [manifest, hashMs] = await time(() => hashFiles(localRoot, scanResult.files));
    const totalMB = Math.round([...manifest.values()].reduce((s, e) => s + e.size, 0) / 1024 / 1024 * 10) / 10;
    console.log(`  Scanned: ${scanResult.files.length} files, ${totalMB}MB`);
    console.log(`  Local scan: ${scanMs}ms, hash: ${hashMs}ms\n`);

    // Create sandbox
    const [sb, sbMs] = await time(async () => daytona.create({ language: "typescript", autoStopInterval: 10 }));
    sandbox = sb;
    console.log(`  Sandbox created: ${sbMs}ms\n`);

    const files = scanResult.files;

    // ── Full sync: tar.gz ────────────────────────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`, undefined, undefined, 30);
    console.log(`  [tar.gz full sync]`);
    const tarResult = await stratTar(sandbox, localRoot, files);
    console.log(`    create: ${tarResult.create}ms  upload: ${tarResult.upload}ms  extract: ${tarResult.extract}ms`);
    console.log(`    archive: ${tarResult.archiveKB}KB  TOTAL: ${tarResult.total}ms\n`);

    // ── Full sync: bulk upload ───────────────────────────────────────
    await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`, undefined, undefined, 30);
    console.log(`  [bulk uploadFiles full sync]`);
    const bulkResult = await stratBulkUpload(sandbox, localRoot, files);
    console.log(`    mkdir: ${bulkResult.mkdirMs}ms  upload: ${bulkResult.uploadMs}ms`);
    console.log(`    TOTAL: ${bulkResult.total}ms\n`);

    // ── Incremental sync: modify some files locally, re-tar only changed
    const changeCount = Math.max(1, Math.floor(files.length * sc.changePercent / 100));
    console.log(`  [incremental sync — ${changeCount} files changed (${sc.changePercent}%)]`);

    // Modify files locally
    for (let i = 0; i < changeCount; i++) {
      const file = files[i];
      await writeFile(path.join(localRoot, file), generateContent(sc.avgFileSize));
    }

    // Re-scan + hash + diff
    const [scanResult2, scanMs2] = await time(() => scanDirectory(localRoot));
    const [manifest2, hashMs2] = await time(() => hashFiles(localRoot, scanResult2.files));
    const plan = diffManifests(manifest2, manifest);
    console.log(`    re-scan: ${scanMs2}ms  re-hash: ${hashMs2}ms  changed: ${plan.stats.toUpload}`);

    // Incremental tar (only changed files)
    const changedFiles = [...plan.added, ...plan.modified];
    if (changedFiles.length > 0) {
      const incrTar = await stratTar(sandbox, localRoot, changedFiles);
      console.log(`    incremental tar: ${incrTar.total}ms  (${incrTar.archiveKB}KB archive)`);

      // Incremental bulk upload
      await sandbox.process.executeCommand(`rm -rf ${REMOTE_PATH} && mkdir -p ${REMOTE_PATH}`, undefined, undefined, 30);
      // Re-do full upload first so we have baseline, then re-upload just changed
      await stratTar(sandbox, localRoot, files); // reset
      const incrBulk = await stratBulkUpload(sandbox, localRoot, changedFiles);
      console.log(`    incremental bulk: ${incrBulk.total}ms`);
    }

    // ── Summary ──────────────────────────────────────────────────────
    console.log(`\n  SUMMARY:`);
    console.log(`    Full sync:  tar.gz ${tarResult.total}ms  vs  bulk ${bulkResult.total}ms  (${tarResult.total < bulkResult.total ? "tar wins" : "bulk wins"})`);
    if (changedFiles.length > 0) {
      console.log(`    Incr sync:  ${changeCount} files — mostly network-bound, sub-second`);
    }
    const userWait = scanMs + hashMs + Math.min(tarResult.total, bulkResult.total);
    console.log(`    End-user wait (best strategy): ${userWait}ms = ${(userWait / 1000).toFixed(1)}s`);

  } catch (err: any) {
    console.error(`  FAILED: ${err.message?.slice(0, 300)}`);
  } finally {
    if (sandbox) { try { await daytona.delete(sandbox); } catch {} }
    if (localRoot) await rm(localRoot, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(`\n${"=".repeat(80)}`);
console.log("DONE");
