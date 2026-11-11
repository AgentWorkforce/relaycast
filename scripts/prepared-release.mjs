#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "./release-contract.mjs";
import {
  assertReleaseMetadata,
  assertReusableReleaseTag,
  assertSourceProvenance,
  provenanceDigest,
  readReleaseProvenance,
} from "./release-provenance.mjs";
import { refreshDockerLock } from "./refresh-docker-lock.mjs";
import { validateReusableReleaseTag } from "./validate-release-tag.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function hasRef(cwd, ref) {
  try {
    git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function date(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("invalid prepared release date");
  }
  return value;
}

function releaseContext(cwd, manifestPath, version, distTag) {
  parseVersion(version);
  const manifest = readReleaseProvenance(path.resolve(cwd, manifestPath));
  assertReleaseMetadata(manifest, version, distTag);
  // The workflow checks out its immutable dispatch SHA. Never prepare or
  // restore a candidate on top of whatever main happens to contain later.
  assertSourceProvenance(
    manifest,
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["rev-parse", "HEAD^{tree}"]),
  );
  return { manifest, digest: provenanceDigest(manifest), tag: `v${version}` };
}

/** Offline preparation: no registry lookup, remote ref write, rebuild or repack. */
export function prepareRelease({
  cwd = process.cwd(),
  manifestPath,
  version,
  distTag,
  releaseDate,
  bundlePath,
  recordPath,
}) {
  const { manifest, digest, tag } = releaseContext(
    cwd,
    manifestPath,
    version,
    distTag,
  );
  const canonicalRef = `refs/tags/${tag}`;
  let validated;
  const validation = {
    cwd,
    tag,
    sourceCommit: manifest.sourceCommit,
    sourceTree: manifest.sourceTree,
    version,
    distTag,
    packageProvenanceDigest: digest,
    provenanceManifest: path.resolve(cwd, manifestPath),
  };
  if (hasRef(cwd, canonicalRef)) {
    // A retry after midnight must retain the original date, tree and commit.
    validated = validateReusableReleaseTag(validation);
    git(cwd, ["reset", "--hard", validated.tagCommit]);
  } else {
    date(releaseDate);
    execFileSync(
      process.execPath,
      [
        path.join(cwd, "scripts/cut-changelog.mjs"),
        "--version",
        version,
        "--date",
        releaseDate,
      ],
      { cwd, stdio: "pipe" },
    );
    const lockPath = path.join(cwd, "docker/package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(
      lockPath,
      `${JSON.stringify(refreshDockerLock(lock, manifest, version), null, 2)}\n`,
    );
    // Capture every tracked change so the unchanged exact validator can reject
    // unexpected source edits instead of silently excluding them from the tag.
    git(cwd, ["add", "--update"]);
    git(cwd, ["config", "user.name", "GitHub Actions"]);
    git(cwd, ["config", "user.email", "actions@github.com"]);
    git(cwd, ["commit", "-m", `chore(release): ${tag}`]);
    const annotation = [
      `Release ${tag}`,
      "",
      `Relaycast-NPM-Dist-Tag: ${distTag}`,
      `Relaycast-Source-Commit: ${manifest.sourceCommit}`,
      `Relaycast-Source-Tree: ${manifest.sourceTree}`,
      `Relaycast-Release-Date: ${releaseDate}`,
      `Relaycast-Package-Provenance-SHA256: ${digest}`,
    ].join("\n");
    git(cwd, ["tag", "-a", tag, "-m", annotation]);
    try {
      validated = validateReusableReleaseTag(validation);
    } catch (error) {
      git(cwd, ["tag", "-d", tag]);
      throw error;
    }
  }

  const bundle = path.resolve(cwd, bundlePath);
  // The final shallow checkout already has the immutable source prerequisite.
  // Transport only the candidate's metadata delta and annotated tag object.
  git(cwd, [
    "bundle",
    "create",
    bundle,
    canonicalRef,
    `^${manifest.sourceCommit}`,
  ]);
  const record = {
    schema: 1,
    version,
    distTag,
    sourceCommit: manifest.sourceCommit,
    sourceTree: manifest.sourceTree,
    provenanceDigest: digest,
    releaseDate: validated.releaseDate,
    tag,
    tagObject: git(cwd, ["rev-parse", canonicalRef]),
    releaseCommit: validated.tagCommit,
    releaseTree: validated.tagTree,
    bundleSha256: sha256(readFileSync(bundle)),
  };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(path.resolve(cwd, recordPath), bytes);
  // This digest travels as a job output, independently of the downloadable
  // artifact. Replacing both record and bundle cannot replace the candidate.
  return { record, recordSha256: sha256(bytes) };
}

/** Import exactly the candidate validated by the build, before any remote push. */
export function restorePreparedRelease({
  cwd = process.cwd(),
  manifestPath,
  version,
  distTag,
  bundlePath,
  recordPath,
  expectedRecordSha256,
}) {
  const { manifest, digest, tag } = releaseContext(
    cwd,
    manifestPath,
    version,
    distTag,
  );
  const bytes = readFileSync(path.resolve(cwd, recordPath));
  if (
    !/^[0-9a-f]{64}$/.test(expectedRecordSha256) ||
    sha256(bytes) !== expectedRecordSha256
  ) {
    throw new Error(
      "prepared release record does not match the trusted build output",
    );
  }
  const record = JSON.parse(bytes);
  if (
    record.schema !== 1 ||
    record.version !== version ||
    record.distTag !== distTag ||
    record.tag !== tag ||
    record.sourceCommit !== manifest.sourceCommit ||
    record.sourceTree !== manifest.sourceTree ||
    record.provenanceDigest !== digest
  ) {
    throw new Error(
      "prepared release does not match immutable source and package provenance",
    );
  }
  date(record.releaseDate);
  for (const key of ["tagObject", "releaseCommit", "releaseTree"]) {
    if (!/^[0-9a-f]{40}$/.test(record[key]))
      throw new Error(`invalid prepared release ${key}`);
  }
  const bundle = path.resolve(cwd, bundlePath);
  if (
    !/^[0-9a-f]{64}$/.test(record.bundleSha256) ||
    sha256(readFileSync(bundle)) !== record.bundleSha256
  ) {
    throw new Error(
      "prepared release bundle does not match the validated record",
    );
  }
  const importedRef = `refs/relaycast/prepared/${record.bundleSha256}`;
  git(cwd, [
    "-c",
    "fetch.fsckObjects=true",
    "fetch",
    "--no-tags",
    bundle,
    `refs/tags/${tag}:${importedRef}`,
  ]);
  if (
    git(cwd, ["rev-parse", importedRef]) !== record.tagObject ||
    git(cwd, ["rev-parse", `${importedRef}^{commit}`]) !== record.releaseCommit
  ) {
    throw new Error(
      "prepared release bundle contains a different tag or commit",
    );
  }
  const parents = git(cwd, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    record.releaseCommit,
  ])
    .split(/\s+/)
    .slice(1);
  if (parents.length !== 1 || parents[0] !== manifest.sourceCommit)
    throw new Error("prepared release commit has the wrong source parent");
  if (
    git(cwd, ["for-each-ref", "--format=%(contents:subject)", importedRef]) !==
    `Release ${tag}`
  ) {
    throw new Error("prepared release tag has the wrong subject");
  }
  const tagMessage = git(cwd, ["cat-file", "tag", importedRef]);
  assertReusableReleaseTag({
    tagType: git(cwd, ["cat-file", "-t", importedRef]),
    tagTree: git(cwd, ["rev-parse", `${importedRef}^{tree}`]),
    releaseTree: record.releaseTree,
    tagMessage,
    version,
    distTag,
    sourceCommit: manifest.sourceCommit,
    sourceTree: manifest.sourceTree,
    packageProvenanceDigest: digest,
  });
  const dates = tagMessage
    .split("\n")
    .filter((line) => line.startsWith("Relaycast-Release-Date: "));
  const actualDate =
    dates.length === 0
      ? new Date(git(cwd, ["show", "-s", "--format=%cI", record.releaseCommit]))
          .toISOString()
          .slice(0, 10)
      : dates[0].slice("Relaycast-Release-Date: ".length);
  if (dates.length > 1 || actualDate !== record.releaseDate)
    throw new Error(
      "prepared release tag date does not match the validated record",
    );
  const canonicalRef = `refs/tags/${tag}`;
  if (hasRef(cwd, canonicalRef)) {
    if (git(cwd, ["rev-parse", canonicalRef]) !== record.tagObject)
      throw new Error(
        "existing release tag differs from the prepared tag object",
      );
  } else {
    git(cwd, ["update-ref", canonicalRef, record.tagObject, "0".repeat(40)]);
  }
  // All identity and digest checks precede executing any prepared-tree files.
  git(cwd, ["reset", "--hard", record.releaseCommit]);
  return record;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (
    index === -1 ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith("--")
  )
    throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const options = {
    manifestPath: argument("--manifest"),
    version: argument("--version"),
    distTag: argument("--dist-tag"),
    bundlePath: argument("--bundle"),
    recordPath: argument("--record"),
  };
  if (process.argv[2] === "prepare") {
    const result = prepareRelease({
      ...options,
      releaseDate: argument("--date"),
    });
    appendFileSync(
      argument("--github-output"),
      `record_sha256=${result.recordSha256}\nrelease_date=${result.record.releaseDate}\n`,
    );
    console.log("Release candidate validated before publication");
  } else if (process.argv[2] === "restore") {
    const record = restorePreparedRelease({
      ...options,
      expectedRecordSha256: argument("--expected-record-sha256"),
    });
    appendFileSync(
      argument("--github-env"),
      `RELEASE_DATE=${record.releaseDate}\n`,
    );
    console.log("Restored the exact prevalidated release candidate");
  } else {
    throw new Error("expected prepare or restore");
  }
}
