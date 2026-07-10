import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const drizzleDir = join(process.cwd(), "packages", "web", "drizzle");
const metaDir = join(drizzleDir, "meta");
const journalPath = join(metaDir, "_journal.json");

type Journal = {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

type JournalEntry = Journal["entries"][number];

const KNOWN_WHEN_VIOLATIONS = new Set([
  // Permanently grandfathered: recovered by 0030_recover_session_events.
  "0020_session_events",
  // Permanently grandfathered: recovered by 0022_ensure_github_clone_jobs.
  "0021_github_clone_jobs",
  // Permanently grandfathered: recovered by 0031_recover_ricky_cloud_autofix.
  "0024_ricky_cloud_autofix",
  // Permanently grandfathered: recovered by 0029_recover_workflow_run_paths.
  "0026_workflow_run_paths",
  // Permanently grandfathered: recovered by 0029_recover_workflow_run_paths.
  "0027_workflow_run_path_pushed_to",
  // Permanently grandfathered: recovered by 0029_recover_workflow_run_paths.
  "0028_ensure_workflow_run_paths",
]);

function findDuplicateMigrationPrefixes(fileNames: string[]): string[] {
  const byPrefix = new Map<string, string[]>();
  for (const file of fileNames) {
    const match = /^(\d{4})_.+\.sql$/.exec(file);
    if (!match) continue;
    const prefix = match[1];
    const files = byPrefix.get(prefix) ?? [];
    files.push(file);
    byPrefix.set(prefix, files);
  }

  return Array.from(byPrefix.entries())
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => `${prefix}: ${files.sort().join(", ")}`)
    .sort();
}

function findDuplicateJournalIndexes(entries: JournalEntry[]): string[] {
  const byIdx = new Map<number, string[]>();
  for (const entry of entries) {
    const tags = byIdx.get(entry.idx) ?? [];
    tags.push(entry.tag);
    byIdx.set(entry.idx, tags);
  }

  return Array.from(byIdx.entries())
    .filter(([, tags]) => tags.length > 1)
    .map(([idx, tags]) => `idx ${idx}: ${tags.sort().join(", ")}`)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function findWhenRegressions(
  entries: JournalEntry[],
  knownViolations: ReadonlySet<string> = KNOWN_WHEN_VIOLATIONS,
): string[] {
  const ordered = entries.slice().sort((a, b) => a.idx - b.idx);
  if (ordered.length === 0) return [];
  const newViolations: string[] = [];
  let highWater = ordered[0]!;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = highWater;
    const cur = ordered[i];
    if (cur.when <= prev.when && !knownViolations.has(cur.tag)) {
      newViolations.push(
        `idx ${cur.idx} (${cur.tag}, when=${cur.when}) is not strictly greater than ` +
          `idx ${prev.idx} (${prev.tag}, when=${prev.when}) — drizzle-kit will silently skip ` +
          `${cur.tag} on every DB where ${prev.tag} already applied. Set ` +
          `\`when: ${prev.when + 1}\` (or any greater value) in the journal entry.`,
      );
    }
    if (cur.when > highWater.when) highWater = cur;
  }
  return newViolations;
}

describe("web drizzle journal", () => {
  it("keeps SQL migration files and journal entries in sync", () => {
    const migrationFiles = readdirSync(drizzleDir).filter((file) => file.endsWith(".sql"));
    const migrationTags = migrationFiles
      .map((file) => file.replace(/\.sql$/, ""))
      .sort();

    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    const journalTags = journal.entries.map((entry) => entry.tag).sort();

    const missingJournalEntries = migrationTags.filter((tag) => !journalTags.includes(tag));
    const missingSqlFiles = journalTags.filter((tag) => !migrationTags.includes(tag));
    const duplicateJournalEntries = journalTags.filter(
      (tag, index) => index > 0 && journalTags[index - 1] === tag,
    );
    const duplicateMigrationPrefixes = findDuplicateMigrationPrefixes(migrationFiles);
    const duplicateJournalIndexes = findDuplicateJournalIndexes(journal.entries);

    assert.deepEqual(
      {
        duplicateJournalEntries,
        duplicateJournalIndexes,
        duplicateMigrationPrefixes,
        missingJournalEntries,
        missingSqlFiles,
      },
      {
        duplicateJournalEntries: [],
        duplicateJournalIndexes: [],
        duplicateMigrationPrefixes: [],
        missingJournalEntries: [],
        missingSqlFiles: [],
      },
    );
  });

  it("has a meta snapshot file for every journal entry", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    const missing: string[] = [];
    for (const entry of journal.entries) {
      const idxPadded = String(entry.idx).padStart(4, "0");
      const snapshotPath = join(metaDir, `${idxPadded}_snapshot.json`);
      if (!existsSync(snapshotPath)) {
        missing.push(`${idxPadded}_snapshot.json (${entry.tag})`);
      }
    }
    assert.deepEqual(missing, [], "Missing drizzle-kit snapshots");
  });

  it("latest snapshot is complete (non-empty and never shrinking)", () => {
    // The post-migrate deploy gate (verify-applied-schema.cjs) reads ONLY
    // the LATEST snapshot. From 0074/0075 through 0081 the latest snapshots
    // were hand-authored empty stubs (`"tables": {}`), which made the gate
    // verify nothing — and the empty schema list produced a Postgres
    // `IN ()` syntax error that warn-only mode swallowed for weeks. The
    // historical stubs are left as-is (they are no longer "latest" and the
    // verifier never reads them), but the LATEST snapshot must always carry
    // the full schema. Regenerate it with
    // `npm run web:drizzle-snapshot:regenerate` after adding a migration.
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    const ordered = journal.entries.slice().sort((a, b) => a.idx - b.idx);
    const latest = ordered[ordered.length - 1]!;

    const tableCount = (entry: JournalEntry): number => {
      const idxPadded = String(entry.idx).padStart(4, "0");
      const snapshotPath = join(metaDir, `${idxPadded}_snapshot.json`);
      if (!existsSync(snapshotPath)) return 0;
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        tables?: Record<string, unknown>;
      };
      return Object.keys(snapshot.tables ?? {}).length;
    };

    const latestCount = tableCount(latest);
    assert.ok(
      latestCount > 0,
      `latest snapshot ${String(latest.idx).padStart(4, "0")}_snapshot.json (${latest.tag}) has zero tables — ` +
        "the schema verify gate would check nothing. Run `npm run web:drizzle-snapshot:regenerate` and commit the result.",
    );

    const maxPriorCount = Math.max(
      0,
      ...ordered.slice(0, -1).map((entry) => tableCount(entry)),
    );
    assert.ok(
      latestCount >= maxPriorCount,
      `latest snapshot (${latest.tag}) has ${latestCount} tables but a prior snapshot has ${maxPriorCount} — ` +
        "the schema can only grow or stay equal across migrations in this repo. If a table was intentionally " +
        "dropped, regenerate the snapshot (`npm run web:drizzle-snapshot:regenerate`) so the contents come from " +
        "the TS schemas rather than hand edits, and explain the drop in the PR.",
    );
  });

  it("entries have strictly increasing `when` timestamps", () => {
    // drizzle-kit migrate filters which migrations to apply by comparing
    // each entry's `when` (folderMillis) against the MAX `created_at` in
    // `__drizzle_migrations`:
    //
    //   if (lastDbMigration.created_at < migration.folderMillis) { apply }
    //
    // If any entry's `when` is less than a prior entry's, it gets
    // silently skipped on every database that already applied the
    // earlier (higher-`when`) migration. Drizzle still reports
    // "migrations applied successfully!" — it just applies zero of
    // them. We hit this in production on 2026-05-04 when 0025 was
    // committed with a timestamp ~5 days in the future and 0026/0027/
    // 0028 were committed with current timestamps; all three were
    // skipped on prod. See `.claude/rules/drizzle-migrations.md`.
    //
    // The entries in KNOWN_WHEN_VIOLATIONS are PERMANENTLY grandfathered:
    // their `when` values are below the prior high-water mark, but the
    // resulting schema gaps on every long-lived stage have already been
    // remedied via later recovery migrations (`when`-correct, idempotent
    // SQL). We intentionally do NOT rewrite the original entries' `when`
    // values because that would break `__drizzle_migrations.created_at`
    // bookkeeping on DBs that did apply them (local dev, PR previews).
    //
    // This list is closed: do NOT add new entries. Any new journal entry
    // whose `when` is not strictly greater than the prior high-water mark
    // must be fixed at the source by bumping the new entry's `when` to
    // the reported minimum or later before merging.
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    const newViolations = findWhenRegressions(journal.entries);
    assert.deepEqual(newViolations, [], "New journal entries must have strictly increasing `when` values");
  });

  it("detects deliberate migration and journal collisions", () => {
    assert.deepEqual(findDuplicateMigrationPrefixes(["0064_alpha.sql", "0064_beta.sql", "0065_next.sql"]), [
      "0064: 0064_alpha.sql, 0064_beta.sql",
    ]);

    assert.deepEqual(
      findDuplicateJournalIndexes([
        { idx: 64, tag: "0064_alpha", when: 1000 },
        { idx: 64, tag: "0064_beta", when: 1001 },
        { idx: 65, tag: "0065_next", when: 1002 },
      ]),
      ["idx 64: 0064_alpha, 0064_beta"],
    );

    assert.deepEqual(
      findWhenRegressions(
        [
          { idx: 64, tag: "0064_alpha", when: 1000 },
          { idx: 65, tag: "0065_next", when: 1000 },
        ],
        new Set(),
      ),
      [
        "idx 65 (0065_next, when=1000) is not strictly greater than idx 64 " +
          "(0064_alpha, when=1000) — drizzle-kit will silently skip 0065_next on every DB " +
          "where 0064_alpha already applied. Set `when: 1001` (or any greater value) in " +
          "the journal entry.",
      ],
    );

    assert.deepEqual(
      findWhenRegressions(
        [
          { idx: 64, tag: "0064_future", when: 2000 },
          { idx: 65, tag: "0065_known_low", when: 1000 },
          { idx: 66, tag: "0066_still_shadowed", when: 1001 },
        ],
        new Set(["0065_known_low"]),
      ),
      [
        "idx 66 (0066_still_shadowed, when=1001) is not strictly greater than idx 64 " +
          "(0064_future, when=2000) — drizzle-kit will silently skip 0066_still_shadowed " +
          "on every DB where 0064_future already applied. Set `when: 2001` (or any " +
          "greater value) in the journal entry.",
      ],
    );
  });

  it("links every snapshot's prevId to the prior snapshot's id", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    const ordered = journal.entries.slice().sort((a, b) => a.idx - b.idx);
    let expectedPrev = "00000000-0000-0000-0000-000000000000";
    for (const entry of ordered) {
      const idxPadded = String(entry.idx).padStart(4, "0");
      const snapshotPath = join(metaDir, `${idxPadded}_snapshot.json`);
      if (!existsSync(snapshotPath)) continue; // covered by prior test
      const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        id: string;
        prevId: string;
      };
      assert.equal(
        snap.prevId,
        expectedPrev,
        `${idxPadded}_snapshot.json prevId does not match prior snapshot id`,
      );
      expectedPrev = snap.id;
    }
  });

  it("keeps GitHub repo index dedupe ties fail-closed", () => {
    const migration = readFileSync(
      join(drizzleDir, "0076_canonical_github_repo_index.sql"),
      "utf8",
    );
    const accessRemovedRank = migration.indexOf("WHEN 'access_removed' THEN 0");
    const unknownRank = migration.indexOf("WHEN 'unknown' THEN 1");
    const activeRank = migration.indexOf("WHEN 'active' THEN 2");

    assert.notEqual(accessRemovedRank, -1);
    assert.notEqual(unknownRank, -1);
    assert.notEqual(activeRank, -1);
    assert.ok(
      accessRemovedRank < unknownRank && unknownRank < activeRank,
      "GitHub repo index dedupe must prefer access_removed over active on exact-timestamp ties",
    );
  });
});
