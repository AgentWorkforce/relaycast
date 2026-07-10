#!/usr/bin/env node
import {
  assertAllSnapshotPinsInSync,
  formatPins,
  readSnapshotPins,
} from "./snapshot-pins-lib.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const repoRoot = readArg("--repo-root") ?? process.cwd();
const expected = readArg("--expect");
const expectedLite = readArg("--expect-lite");

try {
  if (process.argv.includes("--print-canonical")) {
    const pins = await readSnapshotPins(repoRoot);
    console.log(pins[0]?.snapshot ?? "");
    process.exit(0);
  }

  const result = await assertAllSnapshotPinsInSync(repoRoot, expected, expectedLite);
  if (!process.argv.includes("--quiet")) {
    console.log(`Full snapshot pins in sync: ${result.full.expected}`);
    console.log(formatPins(result.full.pins));
    console.log(`Lite snapshot pins in sync: ${result.lite.expected}`);
    console.log(formatPins(result.lite.pins));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
