#!/usr/bin/env -S npx tsx

/**
 * Apply @relayauth/server's bundled D1 migrations to the cloud relayauth
 * database using @relayauth/migrate. Replaces the `wrangler d1 migrations
 * apply` call that previously consumed a hand-maintained copy of the
 * migrations under `packages/relayauth/src/db/migrations/`.
 *
 * Invocation (from the cloud repo root):
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_DEFAULT_ACCOUNT_ID=... \
 *   RELAYAUTH_DATABASE_ID=... \
 *     npx tsx packages/relayauth/scripts/migrate-d1.ts
 *
 * CI resolves the database ID via `sst shell` before invoking this script;
 * see `.github/actions/run-cloudflare-d1-migrations/run.sh`.
 *
 * First-run bootstrap: if the `_migrations` journal is empty but wrangler's
 * legacy `d1_migrations` table already marks some files applied, seed
 * `_migrations` with synthetic entries so we don't re-apply the migrations
 * that wrangler has already run. The synthetic checksum mirrors the bundled
 * upstream file's checksum on the assumption that `0003_tokens_session_and_
 * timestamps.sql` (cloud#312) has brought the schema forward to match upstream.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createD1Runner,
  createFsMigrationSource,
  runMigrations,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from "@relayauth/migrate";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const migrationsDir = resolve(
  repoRoot,
  "node_modules",
  "@relayauth",
  "server",
  "dist",
  "db",
  "migrations",
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

interface D1HttpQueryResponse {
  success: boolean;
  errors?: Array<{ message: string }>;
  result?: Array<{
    results?: unknown[];
    success?: boolean;
    meta?: unknown;
  }>;
}

// Internal: prepare() returns this so batch() can recover each statement's
// SQL and bound params to send as a single atomic request.
interface PreparedStatementInternal<Row = unknown> extends D1PreparedStatementLike<Row> {
  readonly __sql: string;
  readonly __params: () => unknown[];
}

function createD1HttpClient(accountId: string, databaseId: string, apiToken: string): D1DatabaseLike {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  async function post(sql: string, params: unknown[]): Promise<D1ResultLike[]> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`D1 HTTP query failed: ${response.status} ${response.statusText} — ${text}`);
    }

    const payload = (await response.json()) as D1HttpQueryResponse;
    if (!payload.success) {
      const errorMessages = (payload.errors ?? []).map((err) => err.message).join("; ");
      throw new Error(`D1 query error: ${errorMessages || "unknown"}`);
    }

    return (payload.result ?? []).map((entry) => ({
      results: entry.results,
      success: entry.success,
      meta: entry.meta,
    }));
  }

  function prepare<Row = unknown>(sql: string): D1PreparedStatementLike<Row> {
    let boundParams: unknown[] = [];
    const api: PreparedStatementInternal<Row> = {
      __sql: sql,
      __params: () => boundParams,
      bind(...values: unknown[]) {
        boundParams = values;
        return api;
      },
      async run(): Promise<D1ResultLike<Row>> {
        const [first] = await post(sql, boundParams);
        return (first ?? { success: true }) as D1ResultLike<Row>;
      },
      async all(): Promise<D1ResultLike<Row>> {
        const [first] = await post(sql, boundParams);
        return (first ?? { results: [], success: true }) as D1ResultLike<Row>;
      },
      async first<T = Row>(): Promise<T | null> {
        const [first] = await post(sql, boundParams);
        const rows = (first?.results ?? []) as T[];
        return rows[0] ?? null;
      },
    };
    return api;
  }

  return {
    prepare,
    async batch<Row = unknown>(
      statements: D1PreparedStatementLike<Row>[],
    ): Promise<D1ResultLike<Row>[]> {
      if (statements.length === 0) {
        return [];
      }
      // Concatenate statements into one multi-statement SQL string and send
      // in a single POST to /query. Cloudflare processes multi-statement
      // SQL atomically inside one implicit transaction — so a failure in
      // any statement rolls back the whole migration. This is what
      // createD1Runner's exec() relies on for "partially-applied DDL is
      // impossible"; running statements serially via N separate HTTP calls
      // would break that guarantee.
      //
      // D1's /query body takes a single `params` array across the whole
      // multi-statement SQL. createD1Runner's exec path passes raw DDL
      // with no bind values, so `params: []` is correct. If a future
      // caller binds params inside a batch, fail loudly instead of
      // silently dropping them.
      const internals = statements as Array<PreparedStatementInternal<Row>>;
      for (const stmt of internals) {
        const params = stmt.__params();
        if (params.length > 0) {
          throw new Error(
            "createD1HttpClient.batch: bound params are not supported in a batch " +
              "(D1's /query endpoint takes a single params array across the whole multi-statement SQL). " +
              "Split the statement into its own prepare().bind().run() call outside the batch.",
          );
        }
      }
      const combined = internals.map((stmt) => stmt.__sql).join(";\n");
      const results = await post(combined, []);
      return results as D1ResultLike<Row>[];
    },
  };
}

async function bootstrapJournalFromWrangler(db: D1DatabaseLike): Promise<void> {
  // Look for wrangler's legacy journal. Older wrangler versions used
  // `d1_migrations`; current wrangler uses the same name. If the table
  // doesn't exist, bail out quietly — this is probably a fresh DB or one
  // that was never migrated with wrangler.
  const tableCheck = await db
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
    )
    .first();
  if (!tableCheck) {
    console.log("No legacy d1_migrations table found — starting fresh journal.");
    return;
  }

  const legacy = await db
    .prepare<{ name: string; applied_at: string }>(
      "SELECT name, applied_at FROM d1_migrations ORDER BY name ASC",
    )
    .all();

  const legacyEntries = legacy.results ?? [];
  if (legacyEntries.length === 0) {
    return;
  }

  // Check completeness rather than "journal has any row". An interrupted
  // prior bootstrap can leave partial entries in `_migrations`; skipping on
  // non-emptiness would make that state non-recoverable (next run treats
  // the unseeded legacy entries as pending and tries to re-apply them).
  // Instead, build the set of IDs already seeded and only return early if
  // every legacy entry is covered.
  const migrateJournal = await db
    .prepare<{ id: string }>("SELECT id FROM _migrations")
    .all();
  const seededIds = new Set((migrateJournal.results ?? []).map((row) => row.id));
  const legacyIds = legacyEntries.map((row) => row.name.replace(/\.sql$/, ""));
  const missing = legacyIds.filter((id) => !seededIds.has(id));
  if (missing.length === 0) {
    return;
  }

  if (seededIds.size > 0) {
    console.log(
      `Resuming journal bootstrap — ${missing.length} of ${legacyIds.length} legacy entries still missing: ${missing.join(", ")}`,
    );
  } else {
    console.log(`Seeding _migrations from ${legacyEntries.length} legacy wrangler entries ...`);
  }

  const availableFiles = new Map<string, string>();
  const { readdirSync } = await import("node:fs");
  for (const entry of readdirSync(migrationsDir)) {
    if (!entry.endsWith(".sql")) continue;
    const id = entry.replace(/\.sql$/, "");
    const sql = readFileSync(join(migrationsDir, entry), "utf8");
    availableFiles.set(id, sha256(sql));
  }

  for (const row of legacyEntries) {
    const id = row.name.replace(/\.sql$/, "");
    if (seededIds.has(id)) {
      continue;
    }
    const checksum = availableFiles.get(id);
    if (!checksum) {
      // Wrangler recorded a file that no longer exists upstream — e.g. a
      // cloud-only migration like 0003_tokens_session_and_timestamps. Mark
      // it applied with a placeholder checksum so the runner won't try to
      // re-apply it; a matching SQL file isn't shipped upstream anyway.
      console.log(`  ${id}: cloud-only legacy entry, recording as applied`);
      await db
        .prepare(
          "INSERT OR IGNORE INTO _migrations (id, applied_at, checksum) VALUES (?, ?, ?)",
        )
        .bind(id, Date.now(), "cloud-only-legacy-no-upstream-sql")
        .run();
      continue;
    }

    console.log(`  ${id}: seeding with upstream checksum ${checksum.slice(0, 12)}...`);
    await db
      .prepare(
        "INSERT OR IGNORE INTO _migrations (id, applied_at, checksum) VALUES (?, ?, ?)",
      )
      .bind(id, Date.now(), checksum)
      .run();
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const accountId = requireEnv("CLOUDFLARE_DEFAULT_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const databaseId = requireEnv("RELAYAUTH_DATABASE_ID");

  console.log(`Applying relayauth migrations from ${migrationsDir}`);
  const db = createD1HttpClient(accountId, databaseId, apiToken);
  const runner = createD1Runner(db);

  await runner.initialize();
  await bootstrapJournalFromWrangler(db);

  const source = createFsMigrationSource(migrationsDir);
  const result = await runMigrations(runner, source, {
    onApply: (id) => console.log(`  applying ${id} ...`),
  });

  if (result.applied.length === 0) {
    console.log(`No new migrations to apply (${result.skipped.length} already applied).`);
  } else {
    console.log(
      `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
