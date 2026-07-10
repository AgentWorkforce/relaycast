#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const repoRoot = new URL("..", import.meta.url).pathname;
const workerEntry = "packages/persona-compile-worker/src/index.ts";
const wranglerBin = process.env.WRANGLER_BIN || (process.platform === "win32"
  ? "node_modules/.bin/wrangler.cmd"
  : "node_modules/.bin/wrangler");
const maxGzipBytes = parsePositiveIntegerEnv(
  "PERSONA_COMPILE_WORKER_MAX_GZIP_BYTES",
  10 * 1024 * 1024,
);
const outdir = mkdtempSync(join(tmpdir(), "persona-compile-worker-size-"));

try {
  if (!existsSync(resolveRepoPath(wranglerBin))) {
    fail(`wrangler binary not found at ${wranglerBin}; run npm install before size checks.`);
  }

  const wrangler = spawnSync(
    resolveRepoPath(wranglerBin),
    [
      "deploy",
      workerEntry,
      "--dry-run",
      "--outdir",
      outdir,
      "--name",
      "persona-compile-worker-size",
      "--compatibility-date",
      "2026-05-14",
      "--compatibility-flag",
      "nodejs_compat",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (wrangler.status !== 0) {
    process.stderr.write(wrangler.stderr);
    process.stdout.write(wrangler.stdout);
    fail(`wrangler dry-run failed with status ${wrangler.status}.`);
  }

  const files = listFiles(outdir)
    .filter((path) => !path.endsWith("README.md"))
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path,
        rawBytes: bytes.length,
        gzipBytes: gzipSync(bytes, { level: 6 }).length,
      };
    })
    .sort((left, right) => right.gzipBytes - left.gzipBytes);

  const rawBytes = files.reduce((sum, file) => sum + file.rawBytes, 0);
  const gzipBytes = files.reduce((sum, file) => sum + file.gzipBytes, 0);

  console.log("[persona-compile-worker-size] Wrangler dry-run:");
  for (const line of `${wrangler.stdout}${wrangler.stderr}`.trim().split("\n")) {
    if (line.trim()) console.log(`  ${line}`);
  }
  console.log(`[persona-compile-worker-size] Raw artifact bytes: ${formatBytes(rawBytes)}`);
  console.log(`[persona-compile-worker-size] Gzip level 6 sum: ${formatBytes(gzipBytes)}`);
  console.log(`[persona-compile-worker-size] Budget: ${formatBytes(maxGzipBytes)}`);
  console.log("[persona-compile-worker-size] Top emitted files:");
  for (const file of files.slice(0, 8)) {
    console.log(
      `  gzip ${formatBytes(file.gzipBytes)} / raw ${formatBytes(file.rawBytes)}  ${relative(outdir, file.path)}`,
    );
  }

  if (gzipBytes > maxGzipBytes) {
    fail(`gzip size exceeds budget by ${formatBytes(gzipBytes - maxGzipBytes)}.`);
  }

  console.log("[persona-compile-worker-size] PASS: gzip size is within budget.");
} finally {
  rmSync(outdir, { recursive: true, force: true });
}

function parsePositiveIntegerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (!/^[1-9]\d*$/.test(raw)) {
    fail(`${name} must be a positive integer, received ${JSON.stringify(raw)}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail(`${name} must be a safe positive integer, received ${JSON.stringify(raw)}.`);
  }
  return value;
}

function resolveRepoPath(path) {
  return path.startsWith("/") ? path : join(repoRoot, path);
}

function listFiles(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  walk(root);
  return files;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} bytes (${(bytes / 1024).toFixed(2)} KiB)`;
}

function fail(message) {
  console.error(`[persona-compile-worker-size] FAIL: ${message}`);
  process.exit(1);
}
