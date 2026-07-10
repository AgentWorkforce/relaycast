#!/usr/bin/env node
import { Daytona } from "@daytonaio/sdk";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const snapshotName = readArg("--snapshot");
const parsedTimeoutSeconds = Number.parseInt(readArg("--timeout-seconds") ?? "300", 10);
const timeoutSeconds = Number.isNaN(parsedTimeoutSeconds) ? 300 : parsedTimeoutSeconds;

if (!snapshotName) {
  console.error("Usage: node scripts/verify-daytona-snapshot.mjs --snapshot <snapshot-name>");
  process.exit(2);
}

const terminalFailureStates = new Set(["error", "build_failed"]);
const activeStates = new Set(["active"]);
const startedAt = Date.now();
const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });

while (true) {
  const snapshot = await daytona.snapshot.get(snapshotName);
  const state = String(snapshot.state ?? "").toLowerCase();
  console.log(`Snapshot ${snapshotName} state=${state || "(unknown)"}`);

  if (activeStates.has(state)) {
    process.exit(0);
  }
  if (terminalFailureStates.has(state)) {
    console.error(`Snapshot ${snapshotName} reached terminal failure state ${state}: ${snapshot.errorReason ?? ""}`);
    process.exit(1);
  }
  if (Date.now() - startedAt > timeoutSeconds * 1000) {
    console.error(`Timed out waiting for snapshot ${snapshotName} to become active.`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
