/**
 * Shared helpers for the test files that use the PostgreSQL fixture (see
 * postgres.integration.test.ts for the env it needs). Test code only: the
 * runtime handle never takes a lock, and only these helpers drop or
 * truncate anything, always as the owner.
 */
import type pg from "pg";

export const SCHEMA = "relaycast";

/**
 * A session advisory key no product code uses (the migrator keys its lock on
 * the schema OID under its own namespace). Every fixture-touching test file
 * holds it for its whole run, so files that reset or migrate the shared
 * schema never interleave when vitest runs them in parallel.
 */
const FIXTURE_LOCK: readonly [number, number] = [0x52435454, 1];

/** Take the fixture lock on a dedicated owner connection; resolve to its release. */
export async function holdFixtureLock(owner: pg.Pool): Promise<() => Promise<void>> {
  const client = await owner.connect();
  await client.query("SELECT pg_catalog.pg_advisory_lock($1::int4, $2::int4)", [...FIXTURE_LOCK]);
  return async () => {
    try {
      await client.query("SELECT pg_catalog.pg_advisory_unlock($1::int4, $2::int4)", [...FIXTURE_LOCK]);
    } finally {
      client.release();
    }
  };
}

/** Drop everything the owner owns in the schema (never the schema itself, never DROP OWNED). */
export async function resetSchema(owner: pg.Pool): Promise<void> {
  const client = await owner.connect();
  try {
    const q = async (sql: string) =>
      (await client.query<{ stmt: string }>(sql, [SCHEMA])).rows.map(
        (r) => r.stmt,
      );
    const me = `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)`;
    const drops = [
      ...(await q(
        `SELECT format('DROP TABLE IF EXISTS %I.%I CASCADE', n.nspname, c.relname) AS stmt
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relowner = ${me}`,
      )),
      ...(await q(
        `SELECT format('DROP FUNCTION IF EXISTS %s CASCADE', p.oid::regprocedure) AS stmt
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proowner = ${me}`,
      )),
      ...(await q(
        `SELECT format('DROP SEQUENCE IF EXISTS %I.%I CASCADE', n.nspname, c.relname) AS stmt
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'S' AND c.relowner = ${me}`,
      )),
      ...(await q(
        `SELECT format('DROP VIEW IF EXISTS %I.%I CASCADE', n.nspname, c.relname) AS stmt
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') AND c.relowner = ${me}`,
      )),
    ];
    for (const stmt of drops) await client.query(stmt);
    const types = await q(
      `SELECT format('DROP TYPE IF EXISTS %I.%I CASCADE', n.nspname, t.typname) AS stmt
       FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typrelid = 0 AND t.typelem = 0 AND t.typowner = ${me}`,
    );
    for (const stmt of types) await client.query(stmt);
    const left = await client.query(
      `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`,
      [SCHEMA],
    );
    if (left.rowCount)
      throw new Error(
        `schema ${SCHEMA} still has relations: ${left.rows.map((r) => r.relname).join(", ")}`,
      );
  } finally {
    client.release();
  }
}

