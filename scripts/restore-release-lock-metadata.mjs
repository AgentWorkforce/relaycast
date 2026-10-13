#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const lockPath = process.argv[2] ?? "package-lock.json";
const sourceRef = process.argv[3] ?? "HEAD";
const source = JSON.parse(execFileSync(
  "git",
  ["show", `${sourceRef}:${lockPath}`],
  { encoding: "utf8" },
));
const refreshed = JSON.parse(readFileSync(lockPath, "utf8"));
let restored = 0;

for (const [key, entry] of Object.entries(refreshed.packages ?? {})) {
  const sourceEntry = source.packages?.[key];
  if (!sourceEntry || !entry || typeof entry !== "object") continue;
  if (Object.hasOwn(sourceEntry, "peer")) {
    if (entry.peer !== sourceEntry.peer) {
      entry.peer = sourceEntry.peer;
      restored += 1;
    }
  } else if (Object.hasOwn(entry, "peer")) {
    delete entry.peer;
    restored += 1;
  }

  // JSON key order is part of the exact release-tree contract. Assigning a
  // stripped field above appends it, so project every surviving refreshed
  // value through the source entry's key order, then retain any genuinely new
  // npm fields at the end for the validator to assess normally.
  refreshed.packages[key] = Object.fromEntries([
    ...Object.keys(sourceEntry)
      .filter((field) => Object.hasOwn(entry, field))
      .map((field) => [field, entry[field]]),
    ...Object.keys(entry)
      .filter((field) => !Object.hasOwn(sourceEntry, field))
      .map((field) => [field, entry[field]]),
  ]);
}

writeFileSync(lockPath, `${JSON.stringify(refreshed, null, 2)}\n`);
console.log(`Restored source peer metadata on ${restored} lockfile entries`);
