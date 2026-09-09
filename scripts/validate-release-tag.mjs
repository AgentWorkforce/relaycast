#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateComparisonReferences } from "./release-contract.mjs";
import {
  assertSourceProvenance,
  packageProvenance,
  provenanceDigest,
  readReleaseProvenance,
} from "./release-provenance.mjs";

const DOCKER_PACKAGE_NAMES = [
  "@relaycast/a2a",
  "@relaycast/types",
  "@relaycast/engine",
];

const RELEASE_ONLY_PATHS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/sdk-typescript\/src\/version\.ts$/,
  /^packages\/cli\/src\/version\.ts$/,
  /^Dockerfile$/,
  /^docker\/package\.json$/,
  /^docker\/package-lock\.json$/,
  /^RUNBOOK\.md$/,
  /^CHANGELOG\.md$/,
  /^packages\/[^/]+\/CHANGELOG\.md$/,
];

const UNRELEASED =
  /^## \[Unreleased(?: - (Patch|Minor|Major))?\][ \t]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m;
const SECTION_BY_TYPE = new Map([
  ["feat", "Added"], ["fix", "Fixed"], ["perf", "Changed"], ["revert", "Changed"],
  ["deprecate", "Deprecated"], ["deprecated", "Deprecated"],
  ["remove", "Removed"], ["removed", "Removed"], ["security", "Security"],
]);
const SECTION_ORDER = [
  "Breaking Changes", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security",
];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fileAt(cwd, revision, file) {
  return execFileSync("git", ["show", `${revision}:${file}`], { cwd, encoding: "utf8" });
}

function requiredMetadata(tagMessage, lines) {
  for (const line of lines) {
    if (!tagMessage.split("\n").includes(line)) throw new Error(`release tag metadata is missing: ${line}`);
  }
}

function releaseDateFromTag(tagMessage, cwd, tagCommit) {
  const prefix = "Relaycast-Release-Date: ";
  const values = tagMessage.split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
  if (values.length > 1) throw new Error("release tag metadata contains duplicate release dates");
  // Preserve the prior commit-date behavior for tags created before this
  // metadata existed. New tags bind the changelog cut date in the tag object.
  const value = values[0] ?? new Date(git(["show", "-s", "--format=%cI", tagCommit], cwd)).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("release tag metadata has an invalid release date");
  return value;
}

function jsonText(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function setInternalDependencies(pkg, version) {
  for (const dependencyType of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[dependencyType] ?? {})) {
      if (name.startsWith("@relaycast/")) pkg[dependencyType][name] = version;
    }
  }
}

function expectedWorkspaceManifest(source, version) {
  const manifest = JSON.parse(source);
  manifest.version = version;
  setInternalDependencies(manifest, version);
  return jsonText(manifest);
}

function expectedDockerManifest(source, version) {
  const manifest = JSON.parse(source);
  manifest.version = version;
  if (manifest.dependencies?.["@relaycast/engine"] !== undefined) manifest.dependencies["@relaycast/engine"] = version;
  return jsonText(manifest);
}

function packageLockEntryIsWorkspace(key) { return /^packages\/[^/]+$/.test(key); }

function updateLockPackageEntry(entry, version) {
  if (entry && typeof entry === "object") {
    if (entry.version !== undefined) entry.version = version;
    setInternalDependencies(entry, version);
  }
}

function expectedRootLock(source, version) {
  const lock = JSON.parse(source);
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (packageLockEntryIsWorkspace(key)) updateLockPackageEntry(entry, version);
  }
  return lock;
}

function assertLockDiffIsReleaseOnly(source, actual, version, { docker, packageIntegrities }) {
  const before = JSON.parse(source);
  const after = JSON.parse(actual);
  const differences = [];
  function walk(a, b, parts) {
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      if (a !== b) differences.push({ parts, after: b });
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) walk(a[key], b[key], [...parts, key]);
  }
  walk(before, after, []);
  const allowed = (parts, afterValue) => {
    if (docker && parts.length === 1 && parts[0] === "version") return afterValue === version;
    if (parts[0] !== "packages") return false;
    const key = parts[1];
    if (key === "" && docker) {
      if (parts.length === 3 && parts[2] === "version") return afterValue === version;
      if (parts.length === 4 && parts[2] === "dependencies" && parts[3] === "@relaycast/engine") return afterValue === version;
      return false;
    }
    if (!key) return false;
    if (!docker && packageLockEntryIsWorkspace(key)) {
      if (parts.length === 3 && parts[2] === "version") return afterValue === version;
      if (parts.length === 4 && ["dependencies", "devDependencies", "peerDependencies"].includes(parts[2]) && parts[3].startsWith("@relaycast/")) return afterValue === version;
      return false;
    }
    if (!key.startsWith("node_modules/@relaycast/")) return false;
    const packageName = key.slice("node_modules/".length);
    if (parts.length === 3 && parts[2] === "version") return afterValue === version;
    if (parts.length === 3 && parts[2] === "resolved") {
      const shortName = packageName.slice("@relaycast/".length);
      return afterValue === `https://registry.npmjs.org/${packageName}/-/${shortName}-${version}.tgz`;
    }
    if (parts.length === 3 && parts[2] === "integrity") {
      return afterValue === packageIntegrities.get(packageName);
    }
    if (parts.length === 4 && parts[2] === "dependencies" && parts[3].startsWith("@relaycast/")) return afterValue === version;
    return false;
  };
  const unexpected = differences.filter(({ parts, after }) => !allowed(parts, after));
  if (unexpected.length > 0) {
    throw new Error(`${docker ? "docker/package-lock.json" : "package-lock.json"} contains unexpected release edits: ${unexpected.map(({ parts }) => parts.join(".")).join(", ")}`);
  }
}

function expectedDockerLock(source, version, packageIntegrities) {
  const lock = JSON.parse(source);
  lock.version = version;
  const root = lock.packages?.[""];
  if (root) {
    root.version = version;
    if (root.dependencies?.["@relaycast/engine"] !== undefined) root.dependencies["@relaycast/engine"] = version;
  }
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key.startsWith("node_modules/@relaycast/")) {
      updateLockPackageEntry(entry, version);
      const name = key.slice("node_modules/".length);
      const shortName = name.slice("@relaycast/".length);
      const integrity = packageIntegrities.get(name);
      if (!integrity) throw new Error(`release provenance has no Docker integrity for ${name}`);
      entry.resolved = `https://registry.npmjs.org/${name}/-/${shortName}-${version}.tgz`;
      entry.integrity = integrity;
    }
  }
  return lock;
}

function packageIntegritiesFromProvenance({
  provenanceManifest,
  sourceCommit,
  sourceTree,
  version,
  distTag,
  packageProvenanceDigest,
}) {
  const provenance = readReleaseProvenance(provenanceManifest);
  assertSourceProvenance(provenance, sourceCommit, sourceTree);
  if (provenance.version !== version || provenance.distTag !== distTag) {
    throw new Error("release provenance metadata does not match the release tag");
  }
  if (provenanceDigest(provenance) !== packageProvenanceDigest) {
    throw new Error("release provenance digest does not match the release tag");
  }
  return new Map(DOCKER_PACKAGE_NAMES.map((name) => {
    const pkg = packageProvenance(provenance, name);
    if (pkg.version !== version) {
      throw new Error(`${name} provenance version does not match the release`);
    }
    return [name, pkg.integrity];
  }));
}

function treeEntry(cwd, revision, file) {
  const output = execFileSync("git", ["ls-tree", "-z", revision, "--", file], {
    cwd,
    encoding: "utf8",
  });
  const line = output.split("\0").find(Boolean);
  if (!line) return undefined;
  const match = line.match(/^(\d+) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/);
  if (!match) throw new Error(`could not parse ${revision} tree entry for ${file}`);
  return { mode: match[1], type: match[2], object: match[3], path: match[4] };
}

function assertReleaseFileEntries(cwd, sourceCommit, tagCommit, changedPaths) {
  for (const file of changedPaths) {
    const source = treeEntry(cwd, sourceCommit, file);
    const tagged = treeEntry(cwd, tagCommit, file);
    if (!source || !tagged) throw new Error(`release tag must retain a tree entry for ${file}`);
    if (source.mode !== "100644" || source.type !== "blob") {
      throw new Error(`release source entry for ${file} is not a regular 100644 file`);
    }
    if (tagged.mode !== "100644" || tagged.type !== "blob") {
      throw new Error(`release tag changed ${file} to a non-regular or non-100644 entry`);
    }
  }
}

const RUNBOOK_PATTERNS = [
  /(`@relaycast\/engine`\s+\*\*)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(\*\*)/,
  /(version command must print `)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(`)/,
  /(from engine )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(\.)/,
  /(image is on )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?( or later)/,
  /(In engine )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(,)/,
];

function expectedRunbook(source, version) {
  let result = source;
  for (const pattern of RUNBOOK_PATTERNS) {
    if (!pattern.test(result)) throw new Error(`RUNBOOK.md missing expected engine-version anchor: ${pattern}`);
    result = result.replace(pattern, `$1${version}$2`);
  }
  return result;
}

function fallbackBody(cwd, fromTag, sourceCommit) {
  if (!fromTag) return "";
  const subjects = git(["log", `${fromTag}..${sourceCommit}`, "--no-merges", "--pretty=format:%s"], cwd).split("\n").map((line) => line.trim()).filter(Boolean);
  const sections = new Map(SECTION_ORDER.map((section) => [section, []]));
  for (const subject of subjects) {
    const parsed = subject.match(/^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i);
    if (!parsed) continue;
    const [, typeRaw, scope = "", bang, titleRaw] = parsed;
    const type = typeRaw.toLowerCase();
    if (type === "chore" && scope.toLowerCase() === "release") continue;
    const section = bang ? "Breaking Changes" : SECTION_BY_TYPE.get(type);
    if (!section) continue;
    const title = titleRaw.replace(/\s*\(#\d+[^)]*\)/g, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const entry = `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
    if (!sections.get(section).includes(entry)) sections.get(section).push(entry);
  }
  const lines = [];
  for (const section of SECTION_ORDER) {
    const entries = sections.get(section);
    if (entries.length === 0) continue;
    lines.push(`### ${section}`, "", ...entries.map((entry) => `- ${entry}`), "");
  }
  return lines.join("\n").trimEnd();
}

function previousStableTag(cwd, version, sourceCommit) {
  return git(["tag", "-l", "--merged", sourceCommit, "--sort=-v:refname"], cwd).split("\n").map((tag) => tag.trim()).find((tag) => /^v\d+\.\d+\.\d+$/.test(tag) && tag !== `v${version}`);
}

function expectedChangelog(source, { cwd, file, version, sourceCommit, releaseDate }) {
  const match = source.match(UNRELEASED);
  if (!match) return source;
  const curated = match[2].trim();
  const fromTag = previousStableTag(cwd, version, sourceCommit);
  const body = curated || (file === "CHANGELOG.md" ? fallbackBody(cwd, fromTag, sourceCommit) : "");
  if (!body) return source;
  const start = match.index;
  const end = start + match[0].length;
  let result = source.slice(0, start) + `## [Unreleased]\n\n## [${version}] - ${releaseDate}\n\n${body}\n\n` + source.slice(end);
  if (file === "CHANGELOG.md" && fromTag) result = updateComparisonReferences(result, { version, previousVersion: fromTag.replace(/^v/, "") });
  return result;
}

function assertExactReleaseTransform({ cwd, sourceCommit, tagCommit, changedPaths, version, packageIntegrities, releaseDate }) {
  for (const file of changedPaths) {
    const before = fileAt(cwd, sourceCommit, file);
    const after = fileAt(cwd, tagCommit, file);
    let expected;
    if (/^packages\/[^/]+\/package\.json$/.test(file)) expected = expectedWorkspaceManifest(before, version);
    else if (file === "docker/package.json") expected = expectedDockerManifest(before, version);
    else if (file === "package.json") expected = before;
    else if (file === "package-lock.json") {
      assertLockDiffIsReleaseOnly(before, after, version, { docker: false, packageIntegrities });
      expected = jsonText(expectedRootLock(before, version));
    } else if (file === "docker/package-lock.json") {
      assertLockDiffIsReleaseOnly(before, after, version, { docker: true, packageIntegrities });
      expected = jsonText(expectedDockerLock(before, version, packageIntegrities));
    } else if (file === "Dockerfile") expected = before.replace(/^ARG RELAYCAST_ENGINE_VERSION=\S+/m, `ARG RELAYCAST_ENGINE_VERSION=${version}`);
    else if (file === "RUNBOOK.md") expected = expectedRunbook(before, version);
    else if (file.endsWith("/CHANGELOG.md") || file === "CHANGELOG.md") expected = expectedChangelog(before, { cwd, file, version, sourceCommit, releaseDate });
    else if (file === "packages/sdk-typescript/src/version.ts") expected = `export const SDK_VERSION = ${JSON.stringify(version)} as const;\n`;
    else if (file === "packages/cli/src/version.ts") expected = `export const CLI_VERSION = ${JSON.stringify(version)} as const;\n`;
    if (expected === undefined) throw new Error(`no exact release transform for ${file}`);
    if (after !== expected) throw new Error(`release tag changed ${file} outside its exact release transformation`);
  }
}

/** Validate an existing release tag without trusting its annotation alone. */
export function validateReusableReleaseTag({ cwd = process.cwd(), tag, sourceCommit, sourceTree, version, distTag, packageProvenanceDigest, provenanceManifest }) {
  if (git(["cat-file", "-t", tag], cwd) !== "tag") throw new Error(`release tag ${tag} must be annotated`);
  const tagCommit = git(["rev-parse", `${tag}^{commit}`], cwd);
  const tagTree = git(["rev-parse", `${tag}^{tree}`], cwd);
  const actualSourceTree = git(["rev-parse", `${sourceCommit}^{tree}`], cwd);
  if (actualSourceTree !== sourceTree) throw new Error("release provenance source tree does not match source commit");
  const parents = git(["rev-list", "--parents", "-n", "1", tagCommit], cwd).split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== sourceCommit) throw new Error("release tag commit must have exactly one parent equal to the immutable workflow source");
  const tagMessage = git(["cat-file", "tag", tag], cwd);
  const tagSubject = git(["for-each-ref", "--format=%(contents:subject)", `refs/tags/${tag}`], cwd);
  if (tagSubject !== `Release v${version}`) throw new Error(`release tag ${tag} has unexpected release metadata`);
  requiredMetadata(tagMessage, [
    `Release v${version}`, `Relaycast-NPM-Dist-Tag: ${distTag}`, `Relaycast-Source-Commit: ${sourceCommit}`,
    `Relaycast-Source-Tree: ${sourceTree}`, `Relaycast-Package-Provenance-SHA256: ${packageProvenanceDigest}`,
  ]);
  const releaseDate = releaseDateFromTag(tagMessage, cwd, tagCommit);
  const packageIntegrities = packageIntegritiesFromProvenance({
    provenanceManifest,
    sourceCommit,
    sourceTree,
    version,
    distTag,
    packageProvenanceDigest,
  });
  const changedPaths = git(["diff", "--name-only", sourceCommit, tagCommit], cwd).split("\n").map((file) => file.trim()).filter(Boolean);
  if (changedPaths.length === 0) throw new Error("release tag tree has no release changes relative to its source");
  const unexpected = changedPaths.filter((file) => !RELEASE_ONLY_PATHS.some((pattern) => pattern.test(file)));
  if (unexpected.length > 0) throw new Error(`release tag changes non-release paths: ${unexpected.join(", ")}`);
  assertReleaseFileEntries(cwd, sourceCommit, tagCommit, changedPaths);
  assertExactReleaseTransform({ cwd, sourceCommit, tagCommit, changedPaths, version, packageIntegrities, releaseDate });

  const worktree = mkdtempSync(path.join(tmpdir(), "relaycast-release-tag-"));
  try {
    git(["worktree", "add", "--detach", worktree, tagCommit], cwd);
    const check = spawnSync(process.execPath, [path.join(worktree, "scripts", "check-release-contract.mjs"), "--version", version], { cwd: worktree, encoding: "utf8" });
    if (check.status !== 0) throw new Error(`release tag fails semantic release contract: ${check.stderr || check.stdout}`);
  } finally {
    try { git(["worktree", "remove", "--force", worktree], cwd); } finally { rmSync(worktree, { recursive: true, force: true }); }
  }
  return { tagCommit, tagTree, changedPaths };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  validateReusableReleaseTag({
    tag: argument("--tag"), sourceCommit: argument("--source-commit"), sourceTree: argument("--source-tree"), version: argument("--version"),
    distTag: argument("--dist-tag"), packageProvenanceDigest: argument("--provenance-digest"), provenanceManifest: argument("--provenance-manifest"),
  });
}
