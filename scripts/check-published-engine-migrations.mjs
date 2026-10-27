import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENGINE_PACKAGE = "@relaycast/engine";
export const PUBLISHED_STREAM_TAGS = Object.freeze([
  "latest",
  "next",
  "beta",
  "alpha",
]);

// v8.6.0 accidentally rewrote only the header comments of migration 0045.
// Permit exactly the one-way restoration to the v8.5.5 bytes. Any other
// published migration rewrite remains a hard release failure.
export const KNOWN_RECOVERIES = Object.freeze([
  Object.freeze({
    publishedVersion: "8.6.0",
    filename: "0045_workspace_create_idempotency.sql",
    publishedSha256:
      "2746d085bc27c5e43af1e6352df8a7979bf06a8b8f482b52ebd4d9d8d01defc6",
    sourceSha256:
      "7e510f55ea30f74c8e06fa6cfa80395dbb8038dc13877b948266d5eecf12c243",
  }),
]);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sqlFiles(directory) {
  return readdirSync(directory)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
}

function isKnownRecovery({
  publishedVersion,
  filename,
  publishedSha256,
  sourceSha256,
  recoveries,
}) {
  return recoveries.some(
    (recovery) =>
      recovery.publishedVersion === publishedVersion &&
      recovery.filename === filename &&
      recovery.publishedSha256 === publishedSha256 &&
      recovery.sourceSha256 === sourceSha256,
  );
}

export function comparePublishedMigrations({
  sourceDirectory,
  publishedDirectory,
  publishedVersion,
  recoveries = KNOWN_RECOVERIES,
}) {
  const changed = [];
  const missing = [];
  const restored = [];
  // A published engine without its migration directory is malformed, not an
  // empty baseline. Fail closed so every published stream remains protected.
  const publishedFiles = sqlFiles(publishedDirectory);

  for (const filename of publishedFiles) {
    const publishedPath = join(publishedDirectory, filename);
    const sourcePath = join(sourceDirectory, filename);
    let sourceDigest;
    try {
      sourceDigest = sha256(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing.push(filename);
        continue;
      }
      throw error;
    }

    const publishedDigest = sha256(publishedPath);
    if (sourceDigest === publishedDigest) continue;
    if (
      isKnownRecovery({
        publishedVersion,
        filename,
        publishedSha256: publishedDigest,
        sourceSha256: sourceDigest,
        recoveries,
      })
    ) {
      restored.push(filename);
      continue;
    }
    changed.push({ filename, publishedDigest, sourceDigest });
  }

  return {
    checked: publishedFiles.length,
    added: sqlFiles(sourceDirectory).filter(
      (filename) => !publishedFiles.includes(filename),
    ),
    changed,
    missing,
    restored,
  };
}

export function assertPublishedMigrationsImmutable(options) {
  const result = comparePublishedMigrations(options);
  const problems = [
    ...result.missing.map(
      (filename) => `${filename}: missing from the release source`,
    ),
    ...result.changed.map(
      ({ filename, publishedDigest, sourceDigest }) =>
        `${filename}: published sha256 ${publishedDigest}, source sha256 ${sourceDigest}`,
    ),
  ];
  if (problems.length > 0) {
    throw new Error(
      `published engine migrations are immutable:\n${problems
        .map((problem) => `- ${problem}`)
        .join("\n")}`,
    );
  }
  return result;
}

export function downloadPublishedEngine(spec = `${ENGINE_PACKAGE}@latest`) {
  const directory = mkdtempSync(join(tmpdir(), "relaycast-engine-published-"));
  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          spec,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          directory,
        ],
        { encoding: "utf8" },
      ),
    );
    const metadata = Array.isArray(packed)
      ? packed[0]
      : Object.values(packed)[0];
    if (!metadata?.filename) {
      throw new Error(`npm pack returned no artifact metadata for ${spec}`);
    }
    const tarball = join(directory, basename(metadata.filename));
    execFileSync("tar", ["-xzf", tarball, "-C", directory]);
    const packageDirectory = join(directory, "package");
    const manifest = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    );
    if (
      manifest.name !== ENGINE_PACKAGE ||
      typeof manifest.version !== "string"
    ) {
      throw new Error(`npm pack returned an unexpected package for ${spec}`);
    }
    return {
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
      migrationsDirectory: join(packageDirectory, "dist", "db", "migrations"),
      version: manifest.version,
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function parsePublishedEngineDistTags(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output));
  } catch {
    throw new Error("npm returned invalid engine dist-tag JSON");
  }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("npm returned ambiguous engine dist-tag metadata");
  }

  const streams = [];
  const seenVersions = new Set();
  for (const tag of PUBLISHED_STREAM_TAGS) {
    if (!Object.hasOwn(parsed, tag)) continue;
    const version = parsed[tag];
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      version.trim() !== version ||
      /[\u0000-\u0020]/u.test(version)
    ) {
      throw new Error(`npm returned an invalid engine ${tag} dist-tag`);
    }
    if (seenVersions.has(version)) continue;
    seenVersions.add(version);
    streams.push({ tag, version, spec: `${ENGINE_PACKAGE}@${version}` });
  }
  if (streams.length === 0) {
    throw new Error("npm returned no recognized published engine streams");
  }
  return streams;
}

export function readPublishedEngineStreams() {
  return parsePublishedEngineDistTags(
    execFileSync(
      "npm",
      ["view", ENGINE_PACKAGE, "dist-tags", "--json", "--prefer-online"],
      { encoding: "utf8" },
    ),
  );
}

export function verifyPublishedEngineStreams({
  sourceDirectory,
  streams,
  loadPublishedEngine = downloadPublishedEngine,
  recoveries = KNOWN_RECOVERIES,
}) {
  return streams.map((stream) => {
    const published = loadPublishedEngine(stream.spec);
    try {
      const result = assertPublishedMigrationsImmutable({
        sourceDirectory,
        publishedDirectory: published.migrationsDirectory,
        publishedVersion: published.version,
        recoveries,
      });
      return { ...stream, publishedVersion: published.version, result };
    } catch (error) {
      throw new Error(
        `published engine stream ${stream.tag} (${published.version}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      published.cleanup();
    }
  });
}

function main() {
  const requestedSpecs = process.argv.slice(2);
  const streams =
    requestedSpecs.length > 0
      ? requestedSpecs.map((spec, index) => ({
          tag: `explicit-${index + 1}`,
          spec,
        }))
      : readPublishedEngineStreams();
  const verified = verifyPublishedEngineStreams({
    sourceDirectory: resolve("packages/engine/src/db/migrations"),
    streams,
  });
  for (const stream of verified) {
    for (const filename of stream.result.restored) {
      console.warn(
        `approved recovery: restored ${filename} from published ${stream.publishedVersion} to its canonical bytes`,
      );
    }
    console.log(
      `ok — ${stream.tag} (${stream.publishedVersion}): ${stream.result.checked} published engine migration(s) are immutable; ${stream.result.added.length} append-only migration(s) added`,
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
