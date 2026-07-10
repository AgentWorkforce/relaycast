#!/usr/bin/env node
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const workerPath =
  process.argv[2] ?? "packages/web/.open-next-cf/sst-bundle/worker.js";
const cloudflareGzipLimitBytes = 10 * 1024 * 1024;
// Soft early-warning budget, intentionally below the 10,240 KiB Cloudflare hard
// limit (cloudflareGzipLimitBytes above). Locked to ~10,140 KiB after the first
// three proactive-runtime extraction steps landed the real deployed bundle at
// ~9,890 KiB, leaving about 250 KiB of working headroom while preventing a drift
// back toward the Cloudflare ceiling. See AgentWorkforce/cloud#2424.
// Keep this comfortably under cloudflareGzipLimitBytes; if you need to raise it
// again, prefer continuing the worker split instead.
const maxGzipBytes = parsePositiveIntegerEnv(
  "CLOUD_WEB_WORKER_MAX_GZIP_BYTES",
  10140 * 1024,
);
const contributorLimit = parsePositiveIntegerEnv(
  "CLOUD_WEB_WORKER_CONTRIBUTOR_LIMIT",
  12,
);

function parsePositiveIntegerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  if (!/^[1-9]\d*$/.test(raw)) {
    console.error(
      `[cloud-web-worker-size] FAIL: ${name} must be a positive integer, received ${JSON.stringify(raw)}.`,
    );
    process.exit(1);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    console.error(
      `[cloud-web-worker-size] FAIL: ${name} must be a safe positive integer, received ${JSON.stringify(raw)}.`,
    );
    process.exit(1);
  }

  return value;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} bytes (${(bytes / 1024).toFixed(2)} KiB)`;
}

function isInside(root, candidate) {
  const candidateRelativePath = relative(root, candidate);
  return (
    candidateRelativePath === "" ||
    (candidateRelativePath !== "" &&
      !candidateRelativePath.startsWith("..") &&
      !isAbsolute(candidateRelativePath))
  );
}

function fail(message) {
  console.error(`[cloud-web-worker-size] FAIL: ${message}`);
  process.exit(1);
}

function assertExpectedWorkerPath(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`worker artifact not found at ${path}.`);
  }

  if (!stat.isFile()) {
    fail(`worker artifact is not a file at ${path}.`);
  }

  const resolved = realpathSync(path);
  const bundleDir = dirname(resolved);
  const openNextCfDir = dirname(bundleDir);

  if (
    basename(resolved) !== "worker.js" ||
    basename(bundleDir) !== "sst-bundle" ||
    basename(openNextCfDir) !== ".open-next-cf"
  ) {
    fail(
      `worker artifact must be the Cloud Web prebundle at .open-next-cf/sst-bundle/worker.js, got ${path}.`,
    );
  }

  return { bundleDir, resolved };
}

function listFiles(root) {
  const files = [];
  const resolvedRoot = realpathSync(root);

  function walk(dir) {
    const resolvedDir = realpathSync(dir);
    if (!isInside(resolvedRoot, resolvedDir)) {
      fail(`refusing to traverse outside artifact directory: ${dir}.`);
    }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  walk(root);
  return files;
}

function printArtifactContributors(bundleDir) {
  const rows = listFiles(bundleDir)
    .map((path) => ({ path, bytes: statSync(path).size }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, contributorLimit);

  console.log("[cloud-web-worker-size] Top artifact files:");
  for (const row of rows) {
    console.log(
      `  ${formatBytes(row.bytes)}  ${relative(process.cwd(), row.path)}`,
    );
  }
}

function printSourceMapContributors(mapPath) {
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch (error) {
    fail(
      `source map must be readable JSON at ${mapPath}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
  }

  if (!map || typeof map !== "object" || Array.isArray(map)) {
    fail(`source map at ${mapPath} must be a non-null object.`);
  }

  if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
    fail(
      `source map at ${mapPath} must contain sources and sourcesContent arrays.`,
    );
  }

  const rows = map.sources
    .map((source, index) => ({
      source,
      bytes: Buffer.byteLength(map.sourcesContent[index] ?? "", "utf8"),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, contributorLimit);

  console.log("[cloud-web-worker-size] Top source-map contributors:");
  for (const row of rows) {
    console.log(`  ${formatBytes(row.bytes)}  ${row.source}`);
  }
}

const artifact = assertExpectedWorkerPath(workerPath);

const worker = readFileSync(artifact.resolved);
const gzipBytes = gzipSync(worker, { level: 6 }).length;
const rawBytes = worker.length;
const maxHeadroom = maxGzipBytes - gzipBytes;
const hardGateHeadroom = cloudflareGzipLimitBytes - gzipBytes;

console.log(`[cloud-web-worker-size] Artifact: ${workerPath}`);
console.log(`[cloud-web-worker-size] Raw: ${formatBytes(rawBytes)}`);
console.log(
  `[cloud-web-worker-size] Gzip level 6: ${formatBytes(gzipBytes)}`,
);
console.log(
  `[cloud-web-worker-size] Budget: ${formatBytes(maxGzipBytes)} (${formatBytes(maxHeadroom)} headroom)`,
);
console.log(
  `[cloud-web-worker-size] Cloudflare hard gate: ${formatBytes(cloudflareGzipLimitBytes)} (${formatBytes(hardGateHeadroom)} headroom)`,
);

printArtifactContributors(artifact.bundleDir);
printSourceMapContributors(`${artifact.resolved}.map`);

if (gzipBytes > maxGzipBytes) {
  fail(`gzip size exceeds budget by ${formatBytes(gzipBytes - maxGzipBytes)}.`);
}

if (gzipBytes > cloudflareGzipLimitBytes) {
  fail(
    `gzip size exceeds Cloudflare hard gate by ${formatBytes(gzipBytes - cloudflareGzipLimitBytes)}.`,
  );
}

console.log("[cloud-web-worker-size] PASS: gzip size is within budget.");
