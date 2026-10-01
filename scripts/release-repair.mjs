#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertReleaseMetadata,
  assertSourceProvenance,
  provenanceDigest,
  readReleaseProvenance,
} from "./release-provenance.mjs";

/**
 * The 8.8.0 repair is intentionally allow-listed.  A repair must consume the
 * immutable build artifact from the failed run; it must never turn a later
 * checkout into a claim about the source that produced already-published npm
 * bytes.
 */
export const RELAYCAST_8_8_0_REPAIR = Object.freeze({
  runId: "34436226889",
  version: "8.8.0",
  distTag: "latest",
  sourceCommit: "18981479c26ea0677585b4e79301dc23d94ed5c0",
  sourceTree: "3ea102dfb9622e3cc2819feb0cdf202cc029c8e6",
  provenanceDigest: "a18b90273f6b93eb127040bc23f6e66688781e20f1d41c0adde510b287d97917",
  releaseDate: "2026-09-10",
});

const COMMIT = /^[0-9a-f]{40}$/;
const TREE = COMMIT;
const DIGEST = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function equalExpected(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is not the allow-listed 8.8.0 repair value`);
  }
}

/** Validate operator inputs against the one audited 8.8.0 repair fixture. */
export function assertRepairInputs({
  runId,
  version,
  distTag,
  sourceCommit,
  sourceTree,
  packageProvenanceDigest,
  releaseDate = RELAYCAST_8_8_0_REPAIR.releaseDate,
  currentMainCommit,
} = {}) {
  const values = { runId, version, distTag, sourceCommit, sourceTree, packageProvenanceDigest, releaseDate };
  for (const [label, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0020]/.test(value)) {
      throw new Error(`${label} must be a non-empty value without whitespace`);
    }
  }
  if (!COMMIT.test(sourceCommit)) throw new Error("sourceCommit must be a full commit SHA");
  if (!TREE.test(sourceTree)) throw new Error("sourceTree must be a full tree SHA");
  if (!DIGEST.test(packageProvenanceDigest)) throw new Error("packageProvenanceDigest must be a SHA-256 digest");
  if (!DATE.test(releaseDate)) throw new Error("releaseDate must be an ISO date");

  const fixture = RELAYCAST_8_8_0_REPAIR;
  equalExpected(runId, fixture.runId, "runId");
  equalExpected(version, fixture.version, "version");
  equalExpected(distTag, fixture.distTag, "distTag");
  equalExpected(sourceCommit, fixture.sourceCommit, "sourceCommit");
  equalExpected(sourceTree, fixture.sourceTree, "sourceTree");
  equalExpected(packageProvenanceDigest, fixture.provenanceDigest, "packageProvenanceDigest");
  equalExpected(releaseDate, fixture.releaseDate, "releaseDate");
  if (currentMainCommit !== undefined) {
    if (!COMMIT.test(currentMainCommit)) throw new Error("currentMainCommit must be a full commit SHA");
    if (currentMainCommit === sourceCommit) {
      throw new Error("repair source must not be the current main commit");
    }
  }
  return fixture;
}

/** Validate the downloaded manifest and its exact tarball bytes. */
export function assertRepairProvenance({
  manifest,
  artifactRoot,
  sourceCommit,
  sourceTree,
  version,
  distTag,
  packageProvenanceDigest,
} = {}) {
  const parsed = typeof manifest === "string" ? readReleaseProvenance(manifest) : manifest;
  if (!parsed || typeof parsed !== "object") throw new Error("repair provenance must be an object");
  assertSourceProvenance(parsed, sourceCommit, sourceTree);
  assertReleaseMetadata(parsed, version, distTag);
  if (provenanceDigest(parsed) !== packageProvenanceDigest) {
    throw new Error("repair provenance digest does not match the allow-listed artifact");
  }
  if (resolve(artifactRoot) !== artifactRoot) {
    throw new Error("artifactRoot must be an absolute path");
  }
  const seen = new Set();
  for (const pkg of parsed.packages) {
    if (seen.has(pkg.name)) throw new Error(`repair provenance contains duplicate ${pkg.name}`);
    seen.add(pkg.name);
    if (pkg.version !== version) throw new Error(`${pkg.name} provenance version does not match the repair`);
    const tarball = resolve(artifactRoot, pkg.tarball);
    if (tarball !== artifactRoot && !tarball.startsWith(`${artifactRoot}/`)) {
      throw new Error(`${pkg.name} tarball escapes the repair artifact root`);
    }
    const bytes = readFileSync(tarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const shasum = createHash("sha1").update(bytes).digest("hex");
    if (integrity !== pkg.integrity || shasum !== pkg.shasum) {
      throw new Error(`${pkg.name} tarball bytes do not match release provenance`);
    }
  }
  return parsed;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Validate the source object in the checkout before any release mutation. */
export function assertRepairSource({
  workspace = process.cwd(),
  sourceCommit,
  sourceTree,
  gitCommand = git,
} = {}) {
  if (gitCommand(workspace, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]) !== sourceCommit) {
    throw new Error("repair source commit is not available locally");
  }
  const actualTree = gitCommand(workspace, ["rev-parse", `${sourceCommit}^{tree}`]);
  if (actualTree !== sourceTree) {
    throw new Error("repair source tree does not match the audited source commit");
  }
  return { sourceCommit, sourceTree };
}

function argument(name, { optional = false, fallback } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    if (optional) return fallback;
    throw new Error(`${name} is required`);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] !== "validate") throw new Error("command must be validate");
  const sourceCommit = argument("--source-commit");
  const sourceTree = argument("--source-tree");
  const packageProvenanceDigest = argument("--provenance-digest");
  const version = argument("--version");
  const distTag = argument("--dist-tag");
  const fixture = assertRepairInputs({
    runId: argument("--run-id"),
    version,
    distTag,
    sourceCommit,
    sourceTree,
    packageProvenanceDigest,
    releaseDate: argument("--release-date"),
    currentMainCommit: argument("--current-main"),
  });
  const workspace = argument("--workspace");
  assertRepairSource({ workspace, sourceCommit, sourceTree });
  const manifest = argument("--manifest");
  assertRepairProvenance({
    manifest,
    artifactRoot: argument("--artifact-root"),
    sourceCommit,
    sourceTree,
    version,
    distTag,
    packageProvenanceDigest,
  });
  process.stdout.write(`validated ${fixture.version} repair artifact from ${fixture.sourceCommit}\n`);
}
