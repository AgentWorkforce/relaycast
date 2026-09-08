#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertRepositoryChangelogSemver,
  assertRepositoryVersionParity,
} from "./release-contract.mjs";

const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
const version = versionIndex === -1 ? undefined : args[versionIndex + 1];
if (!version) {
  console.error(
    "usage: check-release-contract.mjs --version <x.y.z[-prerelease]>",
  );
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versions = assertRepositoryVersionParity(root, version);
const changelogs = assertRepositoryChangelogSemver(root, version);
const rootChangelog = changelogs[0];
console.log(
  `release contract ok: ${versions.packageCount} manifests, ${versions.publishedPackageCount} published packages, ` +
    `${changelogs.length} changelogs, ${rootChangelog.latestVersion} -> ${version} (${rootChangelog.actualLevel})`,
);
