import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The build job is the only place that turns a source tree into publishable
 * package bytes.  Keep the resulting identity in a small, immutable artifact
 * so a resumed matrix can prove that an already-published version is the
 * exact artifact from this build instead of merely checking that a version
 * exists in npm.
 */
export function readReleaseProvenance(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest || typeof manifest !== "object") {
    throw new Error("release provenance must be an object");
  }
  if (manifest.schema !== 1) {
    throw new Error("release provenance has an unsupported schema");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? "")) {
    throw new Error("release provenance has an invalid source commit");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceTree ?? "")) {
    throw new Error("release provenance has an invalid source tree");
  }
  if (
    typeof manifest.version !== "string" ||
    manifest.version.length === 0 ||
    /\s/.test(manifest.version) ||
    typeof manifest.distTag !== "string" ||
    manifest.distTag.length === 0 ||
    /\s/.test(manifest.distTag)
  ) {
    throw new Error("release provenance has invalid release metadata");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("release provenance has no packages");
  }
  for (const pkg of manifest.packages) {
    if (
      !pkg ||
      typeof pkg.name !== "string" ||
      typeof pkg.version !== "string" ||
      typeof pkg.tarball !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity ?? "") ||
      !/^[0-9a-f]{40}$/.test(pkg.shasum ?? "")
    ) {
      throw new Error("release provenance contains an invalid package entry");
    }
  }
  return manifest;
}

export function packageProvenance(manifest, packageName) {
  const matches = manifest.packages.filter((pkg) => pkg.name === packageName);
  if (matches.length !== 1) {
    throw new Error(`release provenance must contain exactly one ${packageName}`);
  }
  return matches[0];
}

export function assertSourceProvenance(manifest, sourceCommit, sourceTree) {
  if (manifest.sourceCommit !== sourceCommit || manifest.sourceTree !== sourceTree) {
    throw new Error("release artifacts do not match the immutable workflow source");
  }
}

export function assertReleaseMetadata(manifest, version, distTag) {
  if (manifest.version !== version || manifest.distTag !== distTag) {
    throw new Error("release artifacts do not match the requested version and npm dist-tag");
  }
}

export function assertPublishedIntegrity(manifest, packageName, actualIntegrity, expectedVersion) {
  const pkg = packageProvenance(manifest, packageName);
  if (expectedVersion !== undefined && pkg.version !== expectedVersion) {
    throw new Error(`${packageName} provenance version does not match the release`);
  }
  const expected = pkg.integrity;
  if (!actualIntegrity || actualIntegrity !== expected) {
    throw new Error(`${packageName} is published with a different artifact integrity`);
  }
}

export function provenanceDigest(manifest) {
  return createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
}

export function assertReusableReleaseTag({
  tagType,
  tagTree,
  releaseTree,
  tagMessage,
  version,
  distTag,
  sourceCommit,
  sourceTree,
  packageProvenanceDigest,
}) {
  if (tagType !== "tag") throw new Error("release tag must be annotated");
  if (tagTree !== releaseTree) throw new Error("release tag tree differs");
  const required = [
    `Release v${version}`,
    `Relaycast-NPM-Dist-Tag: ${distTag}`,
    `Relaycast-Source-Commit: ${sourceCommit}`,
    `Relaycast-Source-Tree: ${sourceTree}`,
    `Relaycast-Package-Provenance-SHA256: ${packageProvenanceDigest}`,
  ];
  for (const line of required) {
    if (!tagMessage.split("\n").includes(line)) {
      throw new Error(`release tag metadata is missing: ${line}`);
    }
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const command = process.argv[2];
  const manifest = readReleaseProvenance(argument("--manifest"));
  if (command === "package") {
    const pkg = packageProvenance(manifest, argument("--package"));
    const field = argument("--field");
    if (!Object.hasOwn(pkg, field) || typeof pkg[field] !== "string") {
      throw new Error(`unknown package provenance field: ${field}`);
    }
    process.stdout.write(`${pkg[field]}\n`);
  } else if (command === "source") {
    assertSourceProvenance(manifest, argument("--commit"), argument("--tree"));
  } else if (command === "release") {
    assertReleaseMetadata(manifest, argument("--version"), argument("--dist-tag"));
  } else if (command === "published") {
    assertPublishedIntegrity(
      manifest,
      argument("--package"),
      argument("--integrity"),
      optionalArgument("--version"),
    );
  } else if (command === "digest") {
    process.stdout.write(`${provenanceDigest(manifest)}\n`);
  } else {
    throw new Error(`unknown release provenance command: ${command}`);
  }
}
