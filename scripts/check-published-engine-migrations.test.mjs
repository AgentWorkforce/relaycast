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
