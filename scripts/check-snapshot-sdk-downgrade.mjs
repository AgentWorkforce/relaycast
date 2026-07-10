#!/usr/bin/env node
import {
  assertSnapshotDoesNotDowngradeSdk,
  readSnapshotPins,
  snapshotSdkVersion,
} from "./snapshot-pins-lib.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const candidate = readArg("--snapshot");
const current = readArg("--current");
const repoRoot = readArg("--repo-root") ?? process.cwd();
const allowDowngrade = process.argv.includes("--allow-downgrade");

if (!candidate) {
  console.error(
    "Usage: node scripts/check-snapshot-sdk-downgrade.mjs --snapshot <snapshot-name> [--current <snapshot-name>] [--repo-root <path>] [--allow-downgrade]",
  );
  process.exit(2);
}

try {
  const currentSnapshot = current ?? (await readSnapshotPins(repoRoot))[0]?.snapshot;
  if (!currentSnapshot) {
    throw new Error("No current snapshot pin found.");
  }

  const result = assertSnapshotDoesNotDowngradeSdk(candidate, currentSnapshot, {
    allowDowngrade,
  });
  const suffix = allowDowngrade ? " (downgrade override enabled)" : "";
  console.log(
    `Snapshot SDK guard passed: current=${result.currentSdk}, candidate=${result.candidateSdk}${suffix}`,
  );
  console.log(`Current snapshot:   ${currentSnapshot}`);
  console.log(`Candidate snapshot: ${candidate}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (allowDowngrade) {
    try {
      console.error(`Candidate SDK: ${snapshotSdkVersion(candidate)}`);
    } catch {
      // Keep the original validation error clearer.
    }
  }
  process.exit(1);
}
