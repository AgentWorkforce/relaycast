import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, "scripts/check-cloud-web-worker-size.mjs");

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "cloud-worker-size-"));
  const bundleDir = join(root, ".open-next-cf", "sst-bundle");
  const workerPath = join(bundleDir, "worker.js");

  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    workerPath,
    "export default { fetch() { return new Response('ok'); } };\n",
    "utf8",
  );
  writeFileSync(
    join(bundleDir, "worker.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["src/default.ts"],
      sourcesContent: ["export const ok = true;"],
    }),
    "utf8",
  );

  return { bundleDir, workerPath };
}

function runSizeCheck(workerPath, env = {}) {
  return spawnSync(process.execPath, [scriptPath, workerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("check-cloud-web-worker-size passes and reports artifact contributors", () => {
  const { bundleDir, workerPath } = createFixture();
  writeFileSync(
    join(bundleDir, "worker.js.map"),
    JSON.stringify({
      version: 3,
      sources: ["src/large.ts", "src/small.ts"],
      sourcesContent: ["x".repeat(32), "y"],
    }),
    "utf8",
  );

  const result = runSizeCheck(workerPath, {
    CLOUD_WEB_WORKER_MAX_GZIP_BYTES: "1000000",
    CLOUD_WEB_WORKER_CONTRIBUTOR_LIMIT: "2",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: gzip size is within budget/);
  assert.match(result.stdout, /Top artifact files/);
  assert.match(result.stdout, /Top source-map contributors/);
  assert.match(result.stdout, /src\/large\.ts/);
});

test("check-cloud-web-worker-size fails when bundle exceeds configured budget", () => {
  const { workerPath } = createFixture();
  const result = runSizeCheck(workerPath, {
    CLOUD_WEB_WORKER_MAX_GZIP_BYTES: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FAIL: gzip size exceeds budget/);
});

test("check-cloud-web-worker-size fails clearly for missing worker artifact", () => {
  const missingPath = join(tmpdir(), "missing-cloud-worker.js");
  const result = runSizeCheck(missingPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worker artifact not found/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("check-cloud-web-worker-size fails clearly when worker path is not a file", () => {
  const { bundleDir } = createFixture();
  const result = runSizeCheck(bundleDir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worker artifact is not a file/);
  assert.doesNotMatch(result.stderr, /EISDIR/);
});

test("check-cloud-web-worker-size rejects invalid numeric environment config", () => {
  const { workerPath } = createFixture();
  const result = runSizeCheck(workerPath, {
    CLOUD_WEB_WORKER_MAX_GZIP_BYTES: "NaN",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /CLOUD_WEB_WORKER_MAX_GZIP_BYTES must be a positive integer/,
  );
});

test("check-cloud-web-worker-size rejects wrong artifact paths", () => {
  const { bundleDir } = createFixture();
  const wrongPath = join(bundleDir, "README.md");
  writeFileSync(wrongPath, "not the worker", "utf8");

  const result = runSizeCheck(wrongPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be the Cloud Web prebundle/);
});

test("check-cloud-web-worker-size rejects null source maps", () => {
  const { bundleDir, workerPath } = createFixture();
  writeFileSync(join(bundleDir, "worker.js.map"), "null", "utf8");

  const result = runSizeCheck(workerPath, {
    CLOUD_WEB_WORKER_MAX_GZIP_BYTES: "1000000",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source map .* must be a non-null object/);
});
