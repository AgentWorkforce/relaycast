#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_LOCK_KEY = /^packages\/[^/]+$/;
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const INTERNAL_DEPENDENCY_TYPES = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Update only workspace version metadata in the root lockfile.
 *
 * `npm install --package-lock-only` rewrites unrelated lock metadata. npm
 * 11.19.1 drops `peer: true` from lightningcss's platform packages, and exact
 * release validation rejects that diff. The lockfile stays a projection of
 * the committed resolution plus the lockstep workspace version.
 */
export function refreshWorkspaceLock(lock, version) {
  if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json must contain a packages object");
  }
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    throw new Error(`invalid release version: ${version}`);
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!WORKSPACE_LOCK_KEY.test(key) || !entry || typeof entry !== "object") continue;
    if (entry.version !== undefined) entry.version = version;
    for (const dependencyType of INTERNAL_DEPENDENCY_TYPES) {
      for (const dependencyName of Object.keys(entry[dependencyType] ?? {})) {
        if (dependencyName.startsWith("@relaycast/")) {
          entry[dependencyType][dependencyName] = version;
        }
      }
    }
  }
  return lock;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const version = argument("--version");
  const lockPath = resolve(process.cwd(), "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  writeFileSync(lockPath, `${JSON.stringify(refreshWorkspaceLock(lock, version), null, 2)}\n`);
  process.stdout.write(`workspace lockfile refreshed for ${version} without resolving unrelated dependencies\n`);
}
