#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageProvenance, readReleaseProvenance } from "./release-provenance.mjs";

const DOCKER_PACKAGE_KEY = /(?:^|\/)node_modules\/(@relaycast\/[^/]+)$/;

/**
 * Update only the release-owned entries in the self-host lockfile. Running
 * npm update here can refresh unrelated semver ranges (for example zod) and
 * make an otherwise valid release fail exact-tree validation. The lockfile is
 * deliberately treated as a projection of the immutable release manifest;
 * no dependency is resolved or rewritten implicitly.
 */
export function refreshDockerLock(lock, manifest, version) {
  if (!lock || typeof lock !== "object" || !lock.packages) {
    throw new Error("Docker lockfile must contain a packages object");
  }
  if (manifest.version !== version) {
    throw new Error("release provenance version does not match Docker lock version");
  }
  lock.version = version;
  const root = lock.packages[""];
  if (!root || typeof root !== "object") {
    throw new Error("Docker lockfile is missing its root package entry");
  }
  root.version = version;
  if (root.dependencies?.["@relaycast/engine"] !== undefined) {
    root.dependencies["@relaycast/engine"] = version;
  }

  for (const [key, entry] of Object.entries(lock.packages)) {
    const match = key.match(DOCKER_PACKAGE_KEY);
    if (!match) continue;
    const [, packageName] = match;
    const packageEntry = packageProvenance(manifest, packageName);
    if (packageEntry.version !== version) {
      throw new Error(`${packageName} provenance version does not match the release`);
    }
    entry.version = version;
    entry.resolved = `https://registry.npmjs.org/${packageName}/-/${packageName.slice("@relaycast/".length)}-${version}.tgz`;
    entry.integrity = packageEntry.integrity;
    for (const dependencyType of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
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
  const manifest = readReleaseProvenance(argument("--manifest"));
  const version = argument("--version");
  const lockPath = resolve(process.cwd(), "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  writeFileSync(lockPath, `${JSON.stringify(refreshDockerLock(lock, manifest, version), null, 2)}\n`);
  process.stdout.write(`Docker lockfile refreshed for ${version} without resolving unrelated dependencies\n`);
}
