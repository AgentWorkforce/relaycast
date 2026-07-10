#!/usr/bin/env node
import {
  assertAllSnapshotPinsInSync,
  deriveLiteSnapshotName,
  setSnapshotPins,
} from "./snapshot-pins-lib.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const snapshot = readArg("--snapshot");
const liteSnapshot = readArg("--lite-snapshot");
const repoRoot = readArg("--repo-root") ?? process.cwd();

if (!snapshot) {
  console.error("Usage: node scripts/set-snapshot-pins.mjs --snapshot <snapshot-name> [--lite-snapshot <lite-snapshot-name>]");
  process.exit(2);
}

try {
  const resolvedLiteSnapshot = liteSnapshot ?? deriveLiteSnapshotName(snapshot);
  const changed = await setSnapshotPins(snapshot, repoRoot, { liteSnapshot });
  await assertAllSnapshotPinsInSync(repoRoot, snapshot, resolvedLiteSnapshot);
  if (changed.length === 0) {
    console.log(`Snapshot pins already point at ${snapshot} and ${resolvedLiteSnapshot}`);
  } else {
    console.log(`Updated snapshot pins to ${snapshot} and ${resolvedLiteSnapshot}:`);
    for (const file of changed) console.log(`- ${file}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
