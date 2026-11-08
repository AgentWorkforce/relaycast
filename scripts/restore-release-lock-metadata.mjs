#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const [lockPath = "package-lock.json", sourceRef = "HEAD"] = args.filter(
  (arg) => arg !== "--check",
);
const source = JSON.parse(execFileSync(
  "git",
  ["show", `${sourceRef}:${lockPath}`],
  { encoding: "utf8" },
));
const refreshed = JSON.parse(readFileSync(lockPath, "utf8"));
const differences = [];

for (const [key, entry] of Object.entries(refreshed.packages ?? {})) {
  const sourceEntry = source.packages?.[key];
  if (!sourceEntry || !entry || typeof entry !== "object") continue;
  for (const field of ["peer", "dev"]) {
    if (Object.hasOwn(sourceEntry, field)) {
      if (entry[field] !== sourceEntry[field]) {
        entry[field] = sourceEntry[field];
        differences.push(`packages.${key}.${field}`);
      }
    } else if (Object.hasOwn(entry, field)) {
      delete entry[field];
      differences.push(`packages.${key}.${field}`);
    }
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

if (checkOnly) {
  if (differences.length > 0) {
    console.error(`Release lock metadata differs from source: ${differences.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Release lock peer/dev metadata matches source");
  }
} else {
  writeFileSync(lockPath, `${JSON.stringify(refreshed, null, 2)}\n`);
  console.log(`Restored ${differences.length} source peer/dev lockfile flags`);
}
