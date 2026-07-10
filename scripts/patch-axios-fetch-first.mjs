#!/usr/bin/env node
/**
 * Patches installed axios packages so Cloudflare Workers prefer the fetch
 * adapter before the Node http adapter.
 *
 * WHY: axios defaults to ['xhr', 'http', 'fetch']. In workerd with
 * nodejs_compat, xhr is absent and the http adapter can be selected before
 * fetch, then fail in unenv's node:https stub. Several SDKs vendor or hoist
 * their own axios copy, so this scans every installed axios package.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const nodeModulesRoot = resolve(repoRoot, "node_modules");
const checkMode = process.argv.includes("--check");
const LOG = "[patch-axios-fetch-first]";

const targetFiles = [
  "lib/defaults/index.js",
  "dist/node/axios.cjs",
  "dist/esm/axios.js",
  "dist/axios.js",
  "dist/browser/axios.cjs",
];

const nodeFirstAdapterPattern =
  /adapter:\s*\[\s*(['"])xhr\1\s*,\s*(['"])http\2\s*,\s*(['"])fetch\3\s*\]/g;
const fetchFirstAdapterPattern =
  /adapter:\s*\[\s*(['"])fetch\1\s*,\s*(['"])xhr\2\s*,\s*(['"])http\3\s*\]/;
const fetchFirstAdapter = "adapter: ['fetch', 'xhr', 'http']";

if (!existsSync(nodeModulesRoot)) {
  console.log(`${LOG} node_modules not found, skipping.`);
  process.exit(0);
}

const axiosPackages = findAxiosPackages(nodeModulesRoot);
if (axiosPackages.length === 0) {
  console.log(`${LOG} no installed axios packages found, skipping.`);
  process.exit(0);
}

const changed = [];
const stale = [];

for (const axiosRoot of axiosPackages) {
  for (const relativePath of targetFiles) {
    const file = join(axiosRoot, relativePath);
    if (!existsSync(file)) continue;

    const src = readFileSync(file, "utf8");
    const patched = src.replace(nodeFirstAdapterPattern, fetchFirstAdapter);
    if (patched !== src) {
      const displayPath = display(file);
      if (checkMode) {
        stale.push(displayPath);
      } else {
        writeFileSync(file, patched, "utf8");
        changed.push(displayPath);
      }
      continue;
    }

    if (!fetchFirstAdapterPattern.test(src)) {
      console.warn(
        `${LOG} axios adapter defaults not found in ${display(file)}; ` +
          "the package layout may have changed, skipping.",
      );
    }
  }
}

if (checkMode && stale.length > 0) {
  console.error(
    `${LOG} axios adapter defaults are not fetch-first in:\n` +
      stale.map((file) => `  - ${file}`).join("\n") +
      `\nRun \`node scripts/patch-axios-fetch-first.mjs\` or \`npm install\` to fix.`,
  );
  process.exit(1);
}

if (changed.length > 0) {
  console.log(
    `${LOG} patched axios adapter defaults in:\n` +
      changed.map((file) => `  - ${file}`).join("\n"),
  );
} else {
  console.log(`${LOG} axios adapter defaults already fetch-first.`);
}

function findAxiosPackages(root) {
  const found = [];
  const seenDirectories = new Set();

  visitNodeModules(root);
  return found;

  function visitNodeModules(directory) {
    let realDirectory;
    try {
      realDirectory = realpathSync(directory);
    } catch {
      return;
    }
    if (seenDirectories.has(realDirectory)) return;
    seenDirectories.add(realDirectory);

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === ".bin") continue;

      const child = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        visitScope(child);
      } else {
        visitPackage(child);
      }
    }
  }

  function visitScope(scopeDirectory) {
    let entries;
    try {
      entries = readdirSync(scopeDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      visitPackage(join(scopeDirectory, entry.name));
    }
  }

  function visitPackage(packageDirectory) {
    let realDirectory;
    try {
      realDirectory = realpathSync(packageDirectory);
    } catch {
      return;
    }
    if (seenDirectories.has(realDirectory)) return;
    seenDirectories.add(realDirectory);

    const packageJson = join(realDirectory, "package.json");
    if (existsSync(packageJson) && isAxiosPackage(packageJson)) {
      found.push(realDirectory);
    }

    const nestedNodeModules = join(realDirectory, "node_modules");
    if (existsSync(nestedNodeModules)) {
      visitNodeModules(nestedNodeModules);
    }
  }
}

function isAxiosPackage(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return parsed?.name === "axios";
  } catch {
    return false;
  }
}

function display(file) {
  return file.startsWith(`${repoRoot}/`) ? file.slice(repoRoot.length + 1) : file;
}
