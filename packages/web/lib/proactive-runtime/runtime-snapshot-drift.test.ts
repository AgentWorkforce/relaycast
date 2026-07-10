import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKFORCE_RUNTIME_VERSION } from "@cloud/core/proactive-runtime/runtime-package.js";

/**
 * Snapshot ↔ runtime drift guard.
 *
 * The sandbox snapshot pin embeds the runtime version it pre-bakes
 * (`relay-orchestrator-sdk-…-runtime-<X>`). When `WORKFORCE_RUNTIME_VERSION`
 * is bumped without rebaking the snapshot, EVERY deployed-agent fire takes
 * the mismatch npm-install path: slow at best (registry round-trip inside
 * Daytona's ~120s runScript budget), fatal at worst (hn-monitor's first
 * fire, 2026-06-03 — see runtimeDependencyInstallScript in
 * deployment-trigger-delivery.ts). This test makes that drift a PR-time
 * failure instead of a production discovery.
 *
 * KNOWN_DRIFT lists pins that are acknowledged-stale while an ops rebake is
 * in flight. The rebake PR that updates the snapshot pins MUST also empty
 * this list. Do not add entries here to silence a new version bump — bump
 * the snapshot (scripts/snapshot-pins-lib.mjs has the update helper) or
 * coordinate the rebake first.
 */
const KNOWN_DRIFT: ReadonlySet<string> = new Set<string>([
  // Empty: snapshot pins match WORKFORCE_RUNTIME_VERSION (runtime-4.0.1
  // rebake promoted 2026-06-10 by the Rebuild Daytona Snapshot workflow).
  // Only add an entry while a rebake is actively in flight, and remove it
  // in the PR that lands the rebaked pins.
]);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const require = createRequire(import.meta.url);

const PIN_SOURCES: ReadonlyArray<{ id: string; file: string; regex: RegExp }> = [
  {
    id: "ssm-initial-value",
    file: "infra/sandbox-snapshot.ts",
    regex: /value:\s*["'](relay-orchestrator-sdk-[^"']+)["']/,
  },
  {
    id: "ssm-lite-initial-value",
    file: "infra/sandbox-snapshot.ts",
    regex: /value:\s*["'](relay-sandbox-lite-sdk-[^"']+)["']/,
  },
  {
    id: "worker-env",
    file: "infra/web-worker.ts",
    regex: /RELAY_SANDBOX_SNAPSHOT:\s*["'](relay-orchestrator-sdk-[^"']+)["']/,
  },
  {
    id: "wrangler-production-env",
    file: "packages/web/wrangler.production.toml",
    regex: /RELAY_SANDBOX_SNAPSHOT\s*=\s*["'](relay-orchestrator-sdk-[^"']+)["']/,
  },
  {
    id: "worker-lite-env",
    file: "infra/web-worker.ts",
    regex: /RELAY_SANDBOX_LITE_SNAPSHOT:\s*["'](relay-sandbox-lite-sdk-[^"']+)["']/,
  },
  {
    id: "wrangler-lite-env",
    file: "packages/web/wrangler.production.toml",
    regex: /RELAY_SANDBOX_LITE_SNAPSHOT\s*=\s*["'](relay-sandbox-lite-sdk-[^"']+)["']/,
  },
  {
    id: "core-default",
    file: "packages/core/src/config/snapshot.ts",
    regex: /export const DEFAULT_SNAPSHOT = ['"](relay-orchestrator-sdk-[^'"]+)['"]/,
  },
  {
    id: "core-lite-default",
    file: "packages/core/src/config/snapshot.ts",
    regex: /export const DEFAULT_LITE_SNAPSHOT = ['"](relay-sandbox-lite-sdk-[^'"]+)['"]/,
  },
];

function runtimeVersionFromPin(pin: string): string | null {
  const match = /-runtime-([A-Za-z0-9._-]+)$/.exec(pin);
  return match ? match[1] : null;
}

function runtimePinMatchesVersion(pinnedRuntime: string, version: string): boolean {
  return pinnedRuntime === version || pinnedRuntime.startsWith(`${version}-`);
}

describe("sandbox snapshot pin vs WORKFORCE_RUNTIME_VERSION", () => {
  for (const source of PIN_SOURCES) {
    it(`${source.id} (${source.file}) pins a runtime that matches ${WORKFORCE_RUNTIME_VERSION} (or is acknowledged drift)`, async () => {
      const contents = await readFile(path.join(REPO_ROOT, source.file), "utf8");
      const match = source.regex.exec(contents);
      expect(match, `snapshot pin not found in ${source.file}`).not.toBeNull();

      const pin = match![1];
      const pinnedRuntime = runtimeVersionFromPin(pin);
      expect(
        pinnedRuntime,
        `snapshot pin "${pin}" does not embed a -runtime-<version> suffix`,
      ).not.toBeNull();

      const ok =
        runtimePinMatchesVersion(pinnedRuntime!, WORKFORCE_RUNTIME_VERSION) ||
        KNOWN_DRIFT.has(pinnedRuntime!);
      expect(
        ok,
        `Snapshot pin in ${source.file} bakes runtime ${pinnedRuntime} but ` +
          `WORKFORCE_RUNTIME_VERSION is ${WORKFORCE_RUNTIME_VERSION}. Every deployed-agent ` +
          `fire will take the mismatch npm-install path (slow; fatal before the --no-save fix). ` +
          `Rebake the snapshot to runtime-${WORKFORCE_RUNTIME_VERSION} or a runtime-${WORKFORCE_RUNTIME_VERSION}-<variant> suffix (and update the pins via ` +
          `scripts/snapshot-pins-lib.mjs sources), or — only while a rebake is actively in ` +
          `flight — add an acknowledged entry to KNOWN_DRIFT in this test.`,
      ).toBe(true);
    });
  }

  it("KNOWN_DRIFT never contains the current WORKFORCE_RUNTIME_VERSION (stale allowance)", () => {
    // If the rebake landed and matches, the allowance must be deleted —
    // otherwise it would silently cover the NEXT drift.
    expect(KNOWN_DRIFT.has(WORKFORCE_RUNTIME_VERSION)).toBe(false);
  });

  it("keeps the AWS SDK and Smithy client dependency closure internally consistent", async () => {
    const smithy = require("@smithy/smithy-client") as {
      emitWarningIfUnsupportedVersion?: unknown;
    };
    expect(typeof smithy.emitWarningIfUnsupportedVersion).toBe("function");
    expect(() => require("@aws-sdk/client-s3")).not.toThrow();
    expect(() => require("@aws-sdk/lib-storage")).not.toThrow();

    const smokeSource = await readFile(
      path.join(REPO_ROOT, "scripts/smoke-sandbox-image.mjs"),
      "utf8",
    );
    expect(smokeSource).toContain("buildAwsSdkSmithyConsistencyCommand");
    expect(smokeSource).toContain("emitWarningIfUnsupportedVersion");
    expect(smokeSource).toContain("AWS SDK/Smithy runtime import consistency");
  });
});
