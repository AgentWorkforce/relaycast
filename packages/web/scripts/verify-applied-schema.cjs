#!/usr/bin/env node
/*
 * Verify that the database currently reachable via the same connection string
 * resolver as drizzle.config.ts contains every table and column defined in the
 * latest committed drizzle snapshot
 * (packages/web/drizzle/meta/<latest>_snapshot.json).
 *
 * Why this exists: drizzle-kit migrate's `__drizzle_migrations` table can
 * contain hash rows for migrations whose DDL never actually committed
 * (cancelled CI runs that wrote the journal row inside an unfinished
 * transaction, replication lag, manual interference, etc.). When that
 * happens, the next migrate run says "applied successfully" and silently
 * skips the missing DDL. We hit this in PR #397 (recovered by
 * 0022_ensure_github_clone_jobs.sql) and again in PR #303 (recovered by
 * 0028_ensure_workflow_run_paths.sql). This script is the post-migrate
 * gate that turns the silent skip into a CI failure.
 *
 * Scope:
 *   - Verifies every table+column from the latest snapshot exists in the
 *     `public` schema (or the schema declared on the snapshot table).
 *   - Does NOT check column types, defaults, or constraints. Drift on
 *     those is a different class of problem and we want this gate to be
 *     low-noise; the "stamped without DDL" case manifests as a missing
 *     column, which is what we check.
 *   - Extra columns in the DB are ignored. Drizzle migrations are
 *     additive over time; the gate only fails on what's missing.
 *
 * Exit codes:
 *   0  — DB schema satisfies the latest snapshot.
 *   1  — Connection error or unexpected internal failure.
 *   2  — DB schema is missing tables or columns from the snapshot.
 */

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { resolveDrizzleDatabaseUrl } = require("./drizzle-database-url.cjs");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const drizzleDir = path.join(repoRoot, "packages", "web", "drizzle");
const metaDir = path.join(drizzleDir, "meta");

function loadLatestSnapshot() {
  const journal = JSON.parse(
    fs.readFileSync(path.join(metaDir, "_journal.json"), "utf8"),
  );
  const sorted = journal.entries.slice().sort((a, b) => a.idx - b.idx);
  const latest = sorted[sorted.length - 1];
  const idxPadded = String(latest.idx).padStart(4, "0");
  const snapshotPath = path.join(metaDir, `${idxPadded}_snapshot.json`);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  return { latest, snapshotPath, snapshot };
}

function expectedColumns(snapshot) {
  const expected = new Map();
  for (const tableKey of Object.keys(snapshot.tables)) {
    const table = snapshot.tables[tableKey];
    const schema = table.schema && table.schema.length > 0 ? table.schema : "public";
    const tableName = table.name;
    const fqn = `${schema}.${tableName}`;
    expected.set(fqn, new Set(Object.keys(table.columns)));
  }
  return expected;
}

async function loadActualColumns(client, schemas) {
  const placeholders = schemas.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query(
    `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
      WHERE table_schema IN (${placeholders})`,
    schemas,
  );
  const actual = new Map();
  for (const row of rows) {
    const fqn = `${row.table_schema}.${row.table_name}`;
    if (!actual.has(fqn)) actual.set(fqn, new Set());
    actual.get(fqn).add(row.column_name);
  }
  return actual;
}

async function main() {
  const { latest, snapshotPath, snapshot } = loadLatestSnapshot();
  const expected = expectedColumns(snapshot);
  const schemas = Array.from(
    new Set(Array.from(expected.keys()).map((fqn) => fqn.split(".")[0])),
  );

  // An empty latest snapshot means the gate would verify NOTHING (and the
  // empty `IN ()` list is a Postgres syntax error besides). This happened
  // for every hand-stubbed snapshot from 0074/0075 through 0081: the
  // verifier silently died behind warn-only mode. Fail loudly instead —
  // regenerate the latest snapshot with the full table set via
  // `npm run web:drizzle-snapshot:regenerate`.
  if (schemas.length === 0) {
    console.error(
      `verify-applied-schema: FAIL — latest snapshot ${path.basename(snapshotPath)} (idx ${latest.idx}, tag ${latest.tag}) has zero tables. ` +
        "The schema gate cannot verify anything against an empty snapshot. " +
        "Regenerate it with `npm run web:drizzle-snapshot:regenerate` and commit the result.",
    );
    process.exit(2);
  }

  // Mirrors drizzle.config.ts: resolve a single direct Postgres connection
  // string from DATABASE_URL, NEON_MIGRATIONS_DATABASE_URL, NEON_DATABASE_URL,
  // the SST-injected NeonDatabaseUrl secret, or the PG* libpq vars.
  const connectionString = resolveDrizzleDatabaseUrl();
  if (!connectionString) {
    console.error(
      "verify-applied-schema: no connection string (set DATABASE_URL, NEON_MIGRATIONS_DATABASE_URL, NEON_DATABASE_URL, the PG* libpq vars, or run under `sst shell` with NeonDatabaseUrl bound)",
    );
    process.exit(1);
  }

  // Neon connection strings carry `?sslmode=require`; local dev URLs don't.
  const useSsl = !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  const client = new Client({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(`verify-applied-schema: failed to connect: ${err.message}`);
    process.exit(1);
  }

  let actual;
  try {
    actual = await loadActualColumns(client, schemas);
  } catch (err) {
    console.error(`verify-applied-schema: query failed: ${err.message}`);
    await client.end().catch(() => {});
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }

  const missingTables = [];
  const missingColumns = [];
  for (const [fqn, expectedCols] of expected) {
    const actualCols = actual.get(fqn);
    if (!actualCols) {
      missingTables.push(fqn);
      continue;
    }
    for (const col of expectedCols) {
      if (!actualCols.has(col)) {
        missingColumns.push(`${fqn}.${col}`);
      }
    }
  }

  if (missingTables.length === 0 && missingColumns.length === 0) {
    console.log(
      `verify-applied-schema: OK — DB matches snapshot ${path.basename(snapshotPath)} (idx ${latest.idx}, tag ${latest.tag}).`,
    );
    process.exit(0);
  }

  console.error(
    `verify-applied-schema: FAIL — DB schema is behind committed snapshot ${path.basename(snapshotPath)} (idx ${latest.idx}, tag ${latest.tag}).`,
  );
  if (missingTables.length > 0) {
    console.error(`  Missing tables (${missingTables.length}):`);
    for (const t of missingTables) console.error(`    - ${t}`);
  }
  if (missingColumns.length > 0) {
    console.error(`  Missing columns (${missingColumns.length}):`);
    for (const c of missingColumns) console.error(`    - ${c}`);
  }
  console.error(
    "\n  Drizzle's `__drizzle_migrations` table likely has hash rows for migrations whose DDL never committed.",
  );
  console.error(
    "  Recover with an idempotent `ensure` migration that re-asserts the missing tables/columns",
  );
  console.error(
    "  (see packages/web/drizzle/0022_ensure_github_clone_jobs.sql and 0028_ensure_workflow_run_paths.sql for prior art).",
  );
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
