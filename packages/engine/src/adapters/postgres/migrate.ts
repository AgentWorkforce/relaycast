import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "./identity.js";

/** Ledger table inside the engine schema. */
export const LEDGER_TABLE = "_engine_migrations";

/**
 * One bundled migration file.
 *
 * - `generation`: 1-based position in the bundle - the schema generation the
 *   file produces. An image's generation is the number of files it bundles.
 * - `minCompatibleGeneration`: the lowest image generation that can run
 *   against a database where this file is applied. Defaults to the file's own
 *   generation (an image must bundle the file to run on it); a
 *   `-- min_compatible_generation: N` line lowers it for purely additive
 *   migrations an older image tolerates.
 */
export interface BundledMigration {
  name: string;
  sql: string;
  statements: string[];
  checksum: string;
  generation: number;
  minCompatibleGeneration: number;
}

export interface AppliedMigration {
  name: string;
  applied_at: number;
  generation: number;
  min_compatible_generation: number;
  checksum: string;
}

/** A pool-like source of dedicated clients (pg.Pool). */
export interface ClientSource {
  connect(): Promise<Queryable & { release(err?: Error | boolean): void }>;
}

const MIN_COMPAT_HEADER = /^--\s*min_compatible_generation:\s*(\d+)\s*$/m;

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw new Error(`refusing unsafe identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** drizzle-kit statement split; comment-only chunks are dropped. */
export function splitPostgresStatements(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Build bundled migrations from ordered files. Throws on malformed headers. */
export function bundleMigrations(
  files: readonly { name: string; sql: string }[],
): BundledMigration[] {
  return files.map(({ name, sql }, index) => {
    const generation = index + 1;
    const header = MIN_COMPAT_HEADER.exec(sql);
    const minCompatibleGeneration = header ? Number(header[1]) : generation;
    if (minCompatibleGeneration < 1 || minCompatibleGeneration > generation) {
      throw new Error(
        `${name}: min_compatible_generation must be between 1 and ${generation}`,
      );
    }
    return {
      name,
      sql,
      statements: splitPostgresStatements(sql),
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
      generation,
      minCompatibleGeneration,
    };
  });
}

/** `dist/db/migrations-pg` in a build, `src/db/migrations-pg` in dev. */
export function postgresMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../db/migrations-pg"),
    join(here, "../../../src/db/migrations-pg"),
  ];
  return (
    candidates.find((dir) => existsSync(join(dir, "meta/_journal.json"))) ??
    candidates[0]
  );
}

/**
 * Load the bundled migrations in journal order, asserting the drizzle-kit
 * journal and the .sql files agree exactly.
 */
export function loadBundledPostgresMigrations(
  dir = postgresMigrationsDir(),
): BundledMigration[] {
  const journal = JSON.parse(
    readFileSync(join(dir, "meta/_journal.json"), "utf8"),
  ) as {
    dialect: string;
    entries: { idx: number; tag: string }[];
  };
  if (journal.dialect !== "postgresql")
    throw new Error(`${dir}: journal dialect is ${journal.dialect}`);
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  entries.forEach((entry, i) => {
    if (entry.idx !== i)
      throw new Error(`${dir}: journal idx ${entry.idx} out of sequence`);
  });
  const names = entries.map((e) => `${e.tag}.sql`);
  const onDisk = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const missing = names.filter((n) => !onDisk.includes(n));
  const extra = onDisk.filter((n) => !names.includes(n));
  if (missing.length || extra.length) {
    throw new Error(
      `${dir}: journal and files disagree (missing: ${missing.join(", ") || "-"}; unlisted: ${extra.join(", ") || "-"})`,
    );
  }
  return bundleMigrations(
    names.map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") })),
  );
}

/**
 * Advisory lock namespace (first key of the two-int4 form) for engine
 * migrations: ASCII "RCPG". The second key is the target schema's OID, so the
 * lock is scoped to the admitted schema identity rather than to a constant
 * database-wide key: migrators of different schemas never contend, and a
 * schema dropped and re-created under the same name gets a new key.
 */
export const MIGRATION_LOCK_NAMESPACE = 0x52435047;

/** The `(namespace, key)` pair for `pg_advisory_lock(int4, int4)`; the OID is wrapped to int4. */
export function migrationLockKey(schemaOid: number): {
  namespace: number;
  key: number;
} {
  if (
    !Number.isInteger(schemaOid) ||
    schemaOid <= 0 ||
    schemaOid > 0xffffffff
  ) {
    throw new Error(`invalid schema OID ${schemaOid}`);
  }
  return { namespace: MIGRATION_LOCK_NAMESPACE, key: schemaOid | 0 };
}

const LEDGER_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface LedgerAssessment {
  /** Malformed metadata, divergent or interrupted history, checksum drift, incompatibility. */
  problems: string[];
  /** Bundled files not applied yet (always a suffix of the bundle when there are no problems). */
  pending: string[];
  /** Applied rows beyond this bundle, from a newer image that declared this one compatible. */
  unknown: string[];
}

const isInt = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/**
 * Judge the applied ledger against the bundled migrations.
 *
 * Ordering is the explicit integer `generation` (the 1-based position in the
 * bundle), never a comparison of names, checksums, SHAs or digests. An image
 * whose bundle has G files is compatible with the database iff every applied
 * row has `min_compatible_generation <= G`.
 *
 * Refuses (as problems):
 * - rows with missing or malformed metadata (name, applied_at, generation,
 *   min_compatible_generation in 1..generation, sha256 checksum);
 * - duplicate generations or names, or a gap in 1..max(generation): the
 *   history is dirty or was interrupted out of order;
 * - a row at generation <= G that is not the bundled file at that position,
 *   or a bundled file recorded under another generation or checksum
 *   (divergent history / edited migration);
 * - rows that require a newer image.
 */
export function assessLedger(
  rows: readonly Record<string, unknown>[],
  bundled: readonly BundledMigration[],
): LedgerAssessment {
  const problems: string[] = [];
  const generation = bundled.length;
  const valid: AppliedMigration[] = [];
  for (const row of rows) {
    const label =
      typeof row.name === "string" && row.name
        ? row.name
        : JSON.stringify(row.name ?? null);
    const errs: string[] = [];
    if (typeof row.name !== "string" || !LEDGER_NAME.test(row.name))
      errs.push("name");
    if (!isInt(row.applied_at, 0)) errs.push("applied_at");
    if (!isInt(row.generation, 1)) errs.push("generation");
    if (
      !isInt(row.min_compatible_generation, 1) ||
      (isInt(row.generation, 1) &&
        row.min_compatible_generation > row.generation)
    ) {
      errs.push("min_compatible_generation");
    }
    if (typeof row.checksum !== "string" || !SHA256_HEX.test(row.checksum))
      errs.push("checksum");
    if (errs.length)
      problems.push(`ledger row ${label} has malformed ${errs.join(", ")}`);
    else valid.push(row as unknown as AppliedMigration);
  }

  const byGeneration = new Map<number, AppliedMigration>();
  const byName = new Map<string, AppliedMigration>();
  for (const row of valid) {
    if (byGeneration.has(row.generation))
      problems.push(`ledger has two rows at generation ${row.generation}`);
    if (byName.has(row.name))
      problems.push(`ledger has two rows named ${row.name}`);
    byGeneration.set(row.generation, row);
    byName.set(row.name, row);
  }
  const max = Math.max(0, ...valid.map((r) => r.generation));
  const gaps: number[] = [];
  for (let g = 1; g <= max; g++) if (!byGeneration.has(g)) gaps.push(g);
  if (gaps.length)
    problems.push(
      `ledger is missing generation(s) ${gaps.join(", ")} below ${max}: dirty or interrupted history`,
    );

  for (const m of bundled) {
    const atPosition = byGeneration.get(m.generation);
    const named = byName.get(m.name);
    if (atPosition && atPosition.name !== m.name) {
      problems.push(
        `generation ${m.generation} is ${atPosition.name} in the database but ${m.name} in this image`,
      );
    } else if (named && named.generation !== m.generation) {
      problems.push(
        `${m.name} is generation ${named.generation} in the database but ${m.generation} in this image`,
      );
    } else if (named && named.checksum !== m.checksum) {
      problems.push(
        `${m.name} was applied with a different checksum; bundled migrations must never change`,
      );
    }
  }
  for (const row of valid) {
    if (row.min_compatible_generation > generation) {
      problems.push(
        `${row.name} requires image generation >= ${row.min_compatible_generation} (this image is ${generation})`,
      );
    }
  }

  const bundledNames = new Set(bundled.map((m) => m.name));
  return {
    problems,
    pending: bundled.filter((m) => !byName.has(m.name)).map((m) => m.name),
    unknown: valid.filter((r) => !bundledNames.has(r.name)).map((r) => r.name),
  };
}

export interface RunMigrationsOptions {
  schema: string;
  bundled: readonly BundledMigration[];
  /** Runtime role granted SELECT (only) on the ledger. */
  runtimeRole: string;
  /** Seconds since epoch; injectable for tests. */
  now?: () => number;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply pending bundled migrations as the owner role.
 *
 * Locking: one dedicated client runs the whole migrator. It resolves the
 * schema OID and takes the session-level
 * `pg_advisory_lock(MIGRATION_LOCK_NAMESPACE, <schema oid>)` before touching
 * anything, holds it across every transaction below, and releases it in
 * `finally` (closing the connection also releases it). A second migrator of
 * the same schema blocks until the first finishes, then finds nothing to do.
 *
 * Transaction boundaries: (1) create the ledger if needed and pin its
 * privileges (runtime SELECT only); (2..n+1) one transaction per pending
 * file containing its DDL and its ledger row. The ledger rows are the only
 * compatibility state (the floor is max(min_compatible_generation)), so a
 * crash leaves each file and its admission either fully committed or absent.
 *
 * Refuses (throws) on any {@link assessLedger} problem: malformed or
 * divergent ledger, checksum drift, or an applied migration requiring a
 * newer image.
 */
export async function runPostgresMigrations(
  pool: ClientSource,
  opts: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const { schema, bundled, runtimeRole } = opts;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const ledger = `${quoteIdent(schema)}.${quoteIdent(LEDGER_TABLE)}`;

  const client = await pool.connect();
  let lock: { namespace: number; key: number } | undefined;
  let broken = false;

  const inTransaction = async <T>(fn: () => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw err;
    }
  };

  const assess = async (): Promise<LedgerAssessment> => {
    const { rows } = await client.query(
      `SELECT name, applied_at, generation, min_compatible_generation, checksum FROM ${ledger} ORDER BY generation, name`,
    );
    const assessment = assessLedger(rows, bundled);
    if (assessment.problems.length)
      throw new Error(`refusing to migrate: ${assessment.problems.join("; ")}`);
    return assessment;
  };

  try {
    const target = (
      await client.query<{ oid: number }>(
        "SELECT n.oid::int8 AS oid FROM pg_catalog.pg_namespace n WHERE n.nspname = $1",
        [schema],
      )
    ).rows[0];
    if (!target)
      throw new Error(
        `schema ${schema} does not exist (the platform must create it)`,
      );
    lock = migrationLockKey(Number(target.oid));
    await client.query(
      "SELECT pg_catalog.pg_advisory_lock($1::int4, $2::int4)",
      [lock.namespace, lock.key],
    );

    await inTransaction(async () => {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${ledger} (
           name text PRIMARY KEY CHECK (name ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$'),
           applied_at bigint NOT NULL CHECK (applied_at >= 0),
           generation integer NOT NULL UNIQUE CHECK (generation >= 1),
           min_compatible_generation integer NOT NULL
             CHECK (min_compatible_generation >= 1 AND min_compatible_generation <= generation),
           checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$')
         )`,
      );
      const owner = (
        await client.query<{ owner: string; me: string }>(
          `SELECT pg_catalog.pg_get_userbyid(c.relowner)::text AS owner, current_user::text AS me
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2`,
          [schema, LEDGER_TABLE],
        )
      ).rows[0];
      if (!owner || owner.owner !== owner.me) {
        throw new Error(
          `${schema}.${LEDGER_TABLE} is owned by ${owner?.owner ?? "nobody"}, not the migrating role`,
        );
      }
      // Table-level grants on the ledger only (default privileges would also
      // give the runtime role write access): runtime reads, nobody else does.
      await client.query(`REVOKE ALL ON ${ledger} FROM PUBLIC`);
      await client.query(
        `REVOKE ALL ON ${ledger} FROM ${quoteIdent(runtimeRole)}`,
      );
      await client.query(
        `GRANT SELECT ON ${ledger} TO ${quoteIdent(runtimeRole)}`,
      );
      await assess();
    });

    const applied: string[] = [];
    const alreadyApplied: string[] = [];
    for (const migration of bundled) {
      const ran = await inTransaction(async () => {
        const { pending } = await assess();
        if (!pending.includes(migration.name)) return false;
        for (const statement of migration.statements)
          await client.query(statement);
        await client.query(
          `INSERT INTO ${ledger} (name, applied_at, generation, min_compatible_generation, checksum)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            migration.name,
            now(),
            migration.generation,
            migration.minCompatibleGeneration,
            migration.checksum,
          ],
        );
        return true;
      });
      (ran ? applied : alreadyApplied).push(migration.name);
    }
    return { applied, alreadyApplied };
  } finally {
    if (lock && !broken) {
      await client
        .query("SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)", [
          lock.namespace,
          lock.key,
        ])
        .catch(() => {
          broken = true;
        });
    }
    // A broken connection is destroyed, which also drops a held session lock.
    client.release(broken ? true : undefined);
  }
}

export interface VerifyMigrationsOptions {
  schema: string;
  bundled: readonly BundledMigration[];
}

export interface VerifyMigrationsResult {
  ok: boolean;
  /** Bundle size: this image's schema generation. */
  generation: number;
  problems: string[];
  /** Ledger rows not in this bundle (applied by a newer, compatible image). */
  unknown: string[];
}

/**
 * Read-only check that the database is migrated for this image: the ledger
 * exists, every bundled file is applied with the same checksum, and no
 * applied migration requires a newer image. Takes no lock and runs no DDL;
 * safe for the runtime role.
 */
export async function verifyPostgresMigrations(
  client: Queryable,
  opts: VerifyMigrationsOptions,
): Promise<VerifyMigrationsResult> {
  const { schema, bundled } = opts;
  const generation = bundled.length;
  const present = (
    await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2
       ) AS present`,
      [schema, LEDGER_TABLE],
    )
  ).rows[0];
  if (!present?.present) {
    return {
      ok: false,
      generation,
      problems: [
        `${schema}.${LEDGER_TABLE} does not exist; run relaycast-engine migrate`,
      ],
      unknown: [],
    };
  }
  const { rows } = await client.query(
    `SELECT name, applied_at, generation, min_compatible_generation, checksum
     FROM ${quoteIdent(schema)}.${quoteIdent(LEDGER_TABLE)} ORDER BY generation, name`,
  );
  const { problems, pending, unknown } = assessLedger(rows, bundled);
  if (pending.length)
    problems.unshift(`pending migrations: ${pending.join(", ")}`);
  return { ok: problems.length === 0, generation, problems, unknown };
}
