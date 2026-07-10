#!/usr/bin/env node
/**
 * Ensures the project-local Agent Relay broker binary that the `agent-relay`
 * CLI resolves (the top-level `node_modules/@agent-relay/broker-<platform>`)
 * is at least as new as the newest broker copy installed anywhere in the
 * dependency tree.
 *
 * WHY: `agent-relay local up` shells out to the broker resolved from the
 * project's node_modules, preferring the hoisted top-level
 * `@agent-relay/broker-<platform>`. This repo's dependency graph still pulls
 * old `@agent-relay/*` packages (via `@agent-relay/hooks` and
 * `@agentworkforce/sage`) that declare an old broker (6.0.9) as an
 * optionalDependency. npm hoists that stale 6.0.9 binary to the top level,
 * shadowing the modern 8.7.x broker that `@agent-relay/harness-driver`
 * installs (nested). The 8.7.x CLI then invokes the 6.0.9 broker with the
 * `--instance-name` flag, which the old binary rejects:
 *
 *   error: unexpected argument '--instance-name' found
 *   Broker process exited with code 2 before becoming ready
 *
 * so `agent-relay local up` never becomes ready and is cleaned up.
 *
 * npm `overrides` cannot fix this: overrides are not applied to platform-gated
 * optional dependencies (the same class as esbuild/swc native binaries), so a
 * lockfile-level pin is silently ignored. This postinstall patch is the
 * repo-idiomatic fix (see patch-opennext-native-shims.mjs), and survives
 * `npm install` / `npm ci`.
 *
 * The broker binary is local-dev tooling only — it is not imported by any
 * deployed runtime code — so overwriting the stale top-level copy with the
 * newest installed broker is safe.
 *
 * Pass `--check` to fail (exit 1) on drift instead of fixing, for CI.
 */

import { existsSync, readFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const checkMode = process.argv.includes("--check");
const LOG = "[patch-local-broker-version]";

function platformPackage() {
  const arch = process.arch; // 'arm64' | 'x64'
  switch (process.platform) {
    case "darwin":
      return `broker-darwin-${arch}`;
    case "linux":
      return `broker-linux-${arch}`;
    case "win32":
      return `broker-win32-${arch}`;
    default:
      return null;
  }
}

function readVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** numeric semver compare; returns >0 if a is newer than b */
function compareSemver(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * Find every installed copy of the given @agent-relay broker platform package
 * by walking node_modules trees (bounded to @agent-relay scopes for speed).
 */
function findBrokerCopies(brokerPkg) {
  const copies = [];
  const seen = new Set();

  function scanNodeModules(nmDir) {
    if (!existsSync(nmDir)) return;
    const candidate = join(nmDir, "@agent-relay", brokerPkg);
    const version = readVersion(candidate);
    if (version) copies.push({ dir: candidate, version });

    // Recurse into nested node_modules under @agent-relay/* packages, where
    // newer brokers (e.g. harness-driver's) are typically nested.
    const scopeDir = join(nmDir, "@agent-relay");
    let entries = [];
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = join(scopeDir, entry.name, "node_modules");
      const key = nested;
      if (seen.has(key)) continue;
      seen.add(key);
      scanNodeModules(nested);
    }
  }

  // Top-level + one extra well-known nest point: @agentworkforce/sage.
  scanNodeModules(join(repoRoot, "node_modules"));
  scanNodeModules(join(repoRoot, "node_modules", "@agentworkforce", "sage", "node_modules"));

  return copies;
}

const brokerPkg = platformPackage();
if (!brokerPkg) {
  console.log(`${LOG} unsupported platform ${process.platform}/${process.arch}, skipping.`);
  process.exit(0);
}

const topLevelDir = resolve(repoRoot, "node_modules", "@agent-relay", brokerPkg);
const copies = findBrokerCopies(brokerPkg);

if (copies.length === 0) {
  console.log(`${LOG} no @agent-relay/${brokerPkg} installed, skipping.`);
  process.exit(0);
}

const newest = copies.reduce((best, c) =>
  compareSemver(c.version, best.version) > 0 ? c : best
);
const topLevelVersion = readVersion(topLevelDir);

if (topLevelVersion && compareSemver(topLevelVersion, newest.version) >= 0) {
  console.log(
    `${LOG} top-level broker is ${topLevelVersion} (newest available ${newest.version}), nothing to do.`
  );
  process.exit(0);
}

if (checkMode) {
  console.error(
    `${LOG} DRIFT: top-level broker is ${topLevelVersion ?? "missing"} but ` +
      `${newest.version} is installed at ${newest.dir.replace(repoRoot + "/", "")}. ` +
      `Run \`node scripts/patch-local-broker-version.mjs\` (or \`npm install\`) to fix.`
  );
  process.exit(1);
}

console.log(
  `${LOG} replacing top-level broker ${topLevelVersion ?? "(missing)"} with ` +
    `${newest.version} from ${newest.dir.replace(repoRoot + "/", "")}.`
);
rmSync(topLevelDir, { recursive: true, force: true });
cpSync(newest.dir, topLevelDir, { recursive: true });
console.log(`${LOG} done.`);
