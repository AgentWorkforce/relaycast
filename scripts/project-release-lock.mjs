#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseVersion } from "./release-contract.mjs";

/** Change release-owned workspace versions, never resolve a dependency graph. */
export function projectReleaseLock(source, version) {
  parseVersion(version);
  if (
    !source?.packages ||
    typeof source.packages !== "object" ||
    Array.isArray(source.packages)
  ) {
    throw new Error("source lockfile must contain a packages object");
  }
  const lock = structuredClone(source);
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!/^packages\/[^/]+$/.test(key)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("invalid workspace lock entry");
    if (entry.version !== undefined) entry.version = version;
    for (const type of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(entry[type] ?? {})) {
        if (name.startsWith("@relaycast/")) entry[type][name] = version;
      }
    }
  }
  return lock;
}

export function writeProjectedReleaseLock({ cwd = process.cwd(), version }) {
  const source = JSON.parse(
    execFileSync("git", ["show", "HEAD:package-lock.json"], {
      cwd,
      encoding: "utf8",
    }),
  );
  const lockPath = path.join(cwd, "package-lock.json");
  const current = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!isDeepStrictEqual(source, current)) {
    throw new Error(
      "lockfile changed before release projection; dependency changes must be committed to the source first",
    );
  }
  writeFileSync(
    lockPath,
    `${JSON.stringify(projectReleaseLock(source, version), null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const index = process.argv.indexOf("--version");
  if (index === -1 || !process.argv[index + 1])
    throw new Error("--version is required");
  writeProjectedReleaseLock({ version: process.argv[index + 1] });
  console.log(
    "Projected workspace release versions without dependency resolution",
  );
}
