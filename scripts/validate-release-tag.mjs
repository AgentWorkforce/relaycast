#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function requiredMetadata(tagMessage, lines) {
  for (const line of lines) {
    if (!tagMessage.split("\n").includes(line)) {
      throw new Error(`release tag metadata is missing: ${line}`);
    }
  }
}

/**
 * Validate an existing release tag without trusting its annotation alone.
 * The tag must be a direct release commit on the immutable source commit, and
 * its tree may contain only the files the release workflow is allowed to cut.
 * The semantic release contract is checked in a detached worktree before the
 * caller resets its checkout to the tag.
 */
export function validateReusableReleaseTag({
  cwd = process.cwd(),
  tag,
  sourceCommit,
  sourceTree,
  version,
  distTag,
  packageProvenanceDigest,
}) {
  if (git(["cat-file", "-t", tag], cwd) !== "tag") {
    throw new Error(`release tag ${tag} must be annotated`);
  }

  const tagCommit = git(["rev-parse", `${tag}^{commit}`], cwd);
  const tagTree = git(["rev-parse", `${tag}^{tree}`], cwd);
  const actualSourceTree = git(["rev-parse", `${sourceCommit}^{tree}`], cwd);
  if (actualSourceTree !== sourceTree) {
    throw new Error("release provenance source tree does not match source commit");
  }
  if (git(["rev-parse", `${tagCommit}^`], cwd) !== sourceCommit) {
    throw new Error("release tag commit is not directly based on the immutable workflow source");
  }

  const tagMessage = git(["cat-file", "tag", tag], cwd);
  const tagSubject = git(
    ["for-each-ref", "--format=%(contents:subject)", `refs/tags/${tag}`],
    cwd,
  );
  if (tagSubject !== `Release v${version}`) {
    throw new Error(`release tag ${tag} has unexpected release metadata`);
  }
  requiredMetadata(tagMessage, [
    `Release v${version}`,
    `Relaycast-NPM-Dist-Tag: ${distTag}`,
    `Relaycast-Source-Commit: ${sourceCommit}`,
    `Relaycast-Source-Tree: ${sourceTree}`,
    `Relaycast-Package-Provenance-SHA256: ${packageProvenanceDigest}`,
  ]);

  const changedPaths = git(["diff", "--name-only", sourceCommit, tagCommit], cwd)
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
  if (changedPaths.length === 0) {
    throw new Error("release tag tree has no release changes relative to its source");
  }
  const unexpected = changedPaths.filter(
    (file) => !RELEASE_ONLY_PATHS.some((pattern) => pattern.test(file)),
  );
  if (unexpected.length > 0) {
    throw new Error(`release tag changes non-release paths: ${unexpected.join(", ")}`);
  }

  const worktree = mkdtempSync(path.join(tmpdir(), "relaycast-release-tag-"));
  try {
    git(["worktree", "add", "--detach", worktree, tagCommit], cwd);
    const check = spawnSync(
      process.execPath,
      [path.join(worktree, "scripts", "check-release-contract.mjs"), "--version", version],
      { cwd: worktree, encoding: "utf8" },
    );
    if (check.status !== 0) {
      throw new Error(
        `release tag fails semantic release contract: ${check.stderr || check.stdout}`,
      );
    }
  } finally {
    try {
      git(["worktree", "remove", "--force", worktree], cwd);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  }

  return { tagCommit, tagTree, changedPaths };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  validateReusableReleaseTag({
    tag: argument("--tag"),
    sourceCommit: argument("--source-commit"),
    sourceTree: argument("--source-tree"),
    version: argument("--version"),
    distTag: argument("--dist-tag"),
    packageProvenanceDigest: argument("--provenance-digest"),
  });
}
