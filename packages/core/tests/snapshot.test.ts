import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  __resetSnapshotCache,
  DEFAULT_LITE_SNAPSHOT,
  DEFAULT_SNAPSHOT,
  getLiteSnapshotName,
  getSnapshotName,
} from "../src/config/snapshot.js";

const REPO_ROOT = new URL("../../..", import.meta.url);
const originalEnv = { ...process.env };
const originalWarn = console.warn;

async function readSnapshotPin(relativePath: string, regex: RegExp): Promise<string> {
  const source = await readFile(new URL(relativePath, REPO_ROOT), "utf8");
  const match = source.match(regex);
  if (!match?.groups?.snapshot) {
    throw new Error(`Could not parse snapshot pin from ${relativePath}`);
  }
  return match.groups.snapshot;
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(originalEnv)) {
    if (typeof value === "undefined") {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

describe("getSnapshotName", { concurrency: false }, () => {
  beforeEach(() => {
    restoreEnv();
    __resetSnapshotCache();
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.RELAY_SANDBOX_LITE_SNAPSHOT;
    delete process.env.RELAY_SANDBOX_SNAPSHOT;
    delete process.env.SST_STAGE;
    delete process.env.NEXT_PUBLIC_SST_STAGE;
    delete process.env.STAGE;
    console.warn = (() => {}) as typeof console.warn;
  });

  afterEach(() => {
    restoreEnv();
    __resetSnapshotCache();
    console.warn = originalWarn;
  });

  it("returns the env var when set and not on Lambda", async () => {
    process.env.RELAY_SANDBOX_SNAPSHOT = "test-snapshot-x";

    const name = await getSnapshotName();

    assert.equal(name, "test-snapshot-x");
  });

  it("returns the lite env var for lite snapshots when set and not on Lambda", async () => {
    process.env.RELAY_SANDBOX_LITE_SNAPSHOT = "test-lite-snapshot-x";

    const name = await getLiteSnapshotName();

    assert.equal(name, "test-lite-snapshot-x");
  });

  it("falls back to DEFAULT_SNAPSHOT when nothing is set", async () => {
    const name = await getSnapshotName();

    assert.equal(name, DEFAULT_SNAPSHOT);
  });

  it("falls back to DEFAULT_LITE_SNAPSHOT for lite snapshots when nothing is set", async () => {
    const name = await getLiteSnapshotName();

    assert.equal(name, DEFAULT_LITE_SNAPSHOT);
  });

  it("caches the first resolved value within the TTL", async () => {
    process.env.RELAY_SANDBOX_SNAPSHOT = "first";
    const first = await getSnapshotName();

    process.env.RELAY_SANDBOX_SNAPSHOT = "second";
    const second = await getSnapshotName();

    assert.equal(first, "first");
    assert.equal(second, "first");
  });

  it("__resetSnapshotCache allows a new value to propagate", async () => {
    process.env.RELAY_SANDBOX_SNAPSHOT = "first";
    await getSnapshotName();

    __resetSnapshotCache();
    process.env.RELAY_SANDBOX_SNAPSHOT = "second";

    const next = await getSnapshotName();

    assert.equal(next, "second");
  });

  it("caches full and lite snapshot values independently", async () => {
    process.env.RELAY_SANDBOX_SNAPSHOT = "full-first";
    process.env.RELAY_SANDBOX_LITE_SNAPSHOT = "lite-first";
    const full = await getSnapshotName();
    const lite = await getLiteSnapshotName();

    process.env.RELAY_SANDBOX_SNAPSHOT = "full-second";
    process.env.RELAY_SANDBOX_LITE_SNAPSHOT = "lite-second";

    assert.equal(full, "full-first");
    assert.equal(lite, "lite-first");
    assert.equal(await getSnapshotName(), "full-first");
    assert.equal(await getLiteSnapshotName(), "lite-first");
  });

  // Devin review finding #2: parameterPath() must honor NEXT_PUBLIC_SST_STAGE
  // because SST_STAGE / STAGE are NOT set in the Lambda env. This test
  // verifies the fallback warning message includes the expected stage path
  // so we know parameterPath() picked it up.
  it("parameterPath uses NEXT_PUBLIC_SST_STAGE when SST_STAGE is unset", async () => {
    process.env.NEXT_PUBLIC_SST_STAGE = "staging";
    let capturedWarning = "";
    console.warn = ((msg: string) => {
      capturedWarning = String(msg);
    }) as typeof console.warn;

    await getSnapshotName();

    assert.match(capturedWarning, /\/cloud\/staging\/relay-sandbox-snapshot/);
  });

  it("parameterPath prefers SST_STAGE over NEXT_PUBLIC_SST_STAGE when both are set", async () => {
    process.env.SST_STAGE = "production";
    process.env.NEXT_PUBLIC_SST_STAGE = "staging";
    let capturedWarning = "";
    console.warn = ((msg: string) => {
      capturedWarning = String(msg);
    }) as typeof console.warn;

    await getSnapshotName();

    assert.match(capturedWarning, /\/cloud\/production\/relay-sandbox-snapshot/);
  });

  it("keeps every committed snapshot selector in lockstep", async () => {
    const pins = {
      defaultSnapshot: DEFAULT_SNAPSHOT,
      defaultLiteSnapshot: DEFAULT_LITE_SNAPSHOT,
      workerEnv: await readSnapshotPin(
        "infra/web-worker.ts",
        /RELAY_SANDBOX_SNAPSHOT:\s*["'](?<snapshot>relay-orchestrator-sdk-[^"']+)["']/,
      ),
      workerLiteEnv: await readSnapshotPin(
        "infra/web-worker.ts",
        /RELAY_SANDBOX_LITE_SNAPSHOT:\s*["'](?<snapshot>relay-sandbox-lite-sdk-[^"']+)["']/,
      ),
      ssmInitialValue: await readSnapshotPin(
        "infra/sandbox-snapshot.ts",
        /value:\s*["'](?<snapshot>relay-orchestrator-sdk-[^"']+)["']/,
      ),
      wranglerProductionEnv: await readSnapshotPin(
        "packages/web/wrangler.production.toml",
        /RELAY_SANDBOX_SNAPSHOT\s*=\s*["'](?<snapshot>relay-orchestrator-sdk-[^"']+)["']/,
      ),
      ssmLiteInitialValue: await readSnapshotPin(
        "infra/sandbox-snapshot.ts",
        /value:\s*["'](?<snapshot>relay-sandbox-lite-sdk-[^"']+)["']/,
      ),
      wranglerLiteEnv: await readSnapshotPin(
        "packages/web/wrangler.production.toml",
        /RELAY_SANDBOX_LITE_SNAPSHOT\s*=\s*["'](?<snapshot>relay-sandbox-lite-sdk-[^"']+)["']/,
      ),
      docsCurrent: await readSnapshotPin(
        "SNAPSHOT.md",
        /Current snapshot: `(?<snapshot>relay-orchestrator-sdk-[^`]+)`/,
      ),
      docsLiteCurrent: await readSnapshotPin(
        "SNAPSHOT.md",
        /Current lite snapshot: `(?<snapshot>relay-sandbox-lite-sdk-[^`]+)`/,
      ),
    };

    assert.deepEqual(pins, {
      defaultSnapshot: DEFAULT_SNAPSHOT,
      defaultLiteSnapshot: DEFAULT_LITE_SNAPSHOT,
      workerEnv: DEFAULT_SNAPSHOT,
      workerLiteEnv: DEFAULT_LITE_SNAPSHOT,
      ssmInitialValue: DEFAULT_SNAPSHOT,
      wranglerProductionEnv: DEFAULT_SNAPSHOT,
      ssmLiteInitialValue: DEFAULT_LITE_SNAPSHOT,
      wranglerLiteEnv: DEFAULT_LITE_SNAPSHOT,
      docsCurrent: DEFAULT_SNAPSHOT,
      docsLiteCurrent: DEFAULT_LITE_SNAPSHOT,
    });
  });
});
