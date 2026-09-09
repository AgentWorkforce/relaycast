import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  KNOWN_RECOVERIES,
  assertPublishedMigrationsImmutable,
  parsePublishedEngineDistTags,
  verifyPublishedEngineStreams,
} from "./check-published-engine-migrations.mjs";

const temporaryDirectories = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture({ source, published }) {
  const root = mkdtempSync(join(tmpdir(), "relaycast-migrations-test-"));
  temporaryDirectories.push(root);
  const sourceDirectory = join(root, "source");
  const publishedDirectory = join(root, "published");
  mkdirSync(sourceDirectory);
  mkdirSync(publishedDirectory);
  for (const [filename, contents] of Object.entries(source)) {
    writeFileSync(join(sourceDirectory, filename), contents);
  }
  for (const [filename, contents] of Object.entries(published)) {
    writeFileSync(join(publishedDirectory, filename), contents);
  }
  return { sourceDirectory, publishedDirectory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("published engine migration immutability", () => {
  it("accepts unchanged published migrations and append-only additions", () => {
    const directories = fixture({
      published: { "0001_old.sql": "SELECT 1;\n" },
      source: {
        "0001_old.sql": "SELECT 1;\n",
        "0002_new.sql": "SELECT 2;\n",
      },
    });
    assert.deepEqual(
      assertPublishedMigrationsImmutable({
        ...directories,
        publishedVersion: "1.0.0",
      }),
      {
        checked: 1,
        added: ["0002_new.sql"],
        changed: [],
        missing: [],
        restored: [],
      },
    );
  });

  it("rejects changed and removed published migrations", () => {
    const directories = fixture({
      published: {
        "0001_changed.sql": "SELECT 1;\n",
        "0002_missing.sql": "SELECT 2;\n",
      },
      source: { "0001_changed.sql": "SELECT 3;\n" },
    });
    assert.throws(
      () =>
        assertPublishedMigrationsImmutable({
          ...directories,
          publishedVersion: "1.0.0",
        }),
      /0002_missing\.sql[\s\S]*0001_changed\.sql/,
    );
  });

  it("allows only an exact, version-bound recovery", () => {
    const published = "bad published bytes\n";
    const source = "canonical restored bytes\n";
    const directories = fixture({
      published: { "0045_fixture.sql": published },
      source: { "0045_fixture.sql": source },
    });
    const recovery = {
      publishedVersion: "8.6.0",
      filename: "0045_fixture.sql",
      publishedSha256: sha256(published),
      sourceSha256: sha256(source),
    };

    const result = assertPublishedMigrationsImmutable({
      ...directories,
      publishedVersion: "8.6.0",
      recoveries: [recovery],
    });
    assert.deepEqual(result.restored, ["0045_fixture.sql"]);

    assert.throws(
      () =>
        assertPublishedMigrationsImmutable({
          ...directories,
          publishedVersion: "8.6.1",
          recoveries: [recovery],
        }),
      /published engine migrations are immutable/,
    );
  });

  it("protects migrations published only on a prerelease stream", () => {
    const latest = fixture({
      published: { "0001_stable.sql": "SELECT 1;\n" },
      source: {
        "0001_stable.sql": "SELECT 1;\n",
        "0002_prerelease.sql": "SELECT 2;\n",
      },
    });
    const beta = fixture({
      published: {
        "0001_stable.sql": "SELECT 1;\n",
        "0002_prerelease.sql": "SELECT 'published beta bytes';\n",
      },
      source: {
        "0001_stable.sql": "SELECT 1;\n",
        "0002_prerelease.sql": "SELECT 2;\n",
      },
    });
    const directories = new Map([
      ["@relaycast/engine@8.5.5", latest.publishedDirectory],
      ["@relaycast/engine@8.6.0-beta.1", beta.publishedDirectory],
    ]);

    assert.throws(
      () =>
        verifyPublishedEngineStreams({
          sourceDirectory: latest.sourceDirectory,
          streams: [
            {
              tag: "latest",
              version: "8.5.5",
              spec: "@relaycast/engine@8.5.5",
            },
            {
              tag: "beta",
              version: "8.6.0-beta.1",
              spec: "@relaycast/engine@8.6.0-beta.1",
            },
          ],
          loadPublishedEngine: (spec) => ({
            cleanup() {},
            migrationsDirectory: directories.get(spec),
            version: spec.slice(spec.lastIndexOf("@") + 1),
          }),
        }),
      /published engine stream beta \(8\.6\.0-beta\.1\)[\s\S]*0002_prerelease\.sql/,
    );
  });

  it("reads every recognized dist-tag head and deduplicates versions", () => {
    assert.deepEqual(
      parsePublishedEngineDistTags(
        JSON.stringify([
          {
            latest: "8.6.0",
            next: "8.7.0-beta.1",
            beta: "8.7.0-beta.1",
            alpha: "8.8.0-alpha.1",
            legacy: "1.0.0",
          },
        ]),
      ),
      [
        {
          tag: "latest",
          version: "8.6.0",
          spec: "@relaycast/engine@8.6.0",
        },
        {
          tag: "next",
          version: "8.7.0-beta.1",
          spec: "@relaycast/engine@8.7.0-beta.1",
        },
        {
          tag: "alpha",
          version: "8.8.0-alpha.1",
          spec: "@relaycast/engine@8.8.0-alpha.1",
        },
      ],
    );
  });

  it("pins the one production recovery to the observed registry digests", () => {
    assert.deepEqual(KNOWN_RECOVERIES, [
      {
        publishedVersion: "8.6.0",
        filename: "0045_workspace_create_idempotency.sql",
        publishedSha256:
          "2746d085bc27c5e43af1e6352df8a7979bf06a8b8f482b52ebd4d9d8d01defc6",
        sourceSha256:
          "7e510f55ea30f74c8e06fa6cfa80395dbb8038dc13877b948266d5eecf12c243",
      },
    ]);

    const recovery = KNOWN_RECOVERIES[0];
    const sourcePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "packages",
      "engine",
      "src",
      "db",
      "migrations",
      recovery.filename,
    );
    assert.equal(sha256(readFileSync(sourcePath)), recovery.sourceSha256);
  });
});
