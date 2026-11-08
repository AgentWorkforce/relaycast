/**
 * vitest setupFiles for the PostgreSQL conformance mode (replaces
 * bindSchema.ts). Opens the verified runtime handle before any test module
 * loads (which binds the engine tables to 'pg'); a connection or verification
 * failure fails the file, never falls back. Before every test, TRUNCATEs every
 * engine table as the owner (test code only; the runtime never does this).
 */
import { afterAll, beforeEach } from 'vitest';
import { openPostgresEngineDb } from '../../adapters/postgres/engineDb.js';
import { closePostgresPool, openPostgresPool } from '../../adapters/postgres/pool.js';
import { setConformancePgDb } from '../conformance/pgMode.js';
import { CONFORMANCE_PG_SCHEMA, conformancePgConfig } from './conformancePgEnv.js';

const handle = await openPostgresEngineDb(conformancePgConfig('runtime'));
const owner = openPostgresPool(conformancePgConfig('owner'), { log: () => {} });
setConformancePgDb(handle.db);

const { rows } = await owner.query<{ name: string }>(
  `SELECT format('%I.%I', n.nspname, c.relname) AS name
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname <> '_engine_migrations'
   ORDER BY 1`,
  [CONFORMANCE_PG_SCHEMA],
);
if (rows.length === 0) throw new Error(`schema ${CONFORMANCE_PG_SCHEMA} has no tables; did globalSetup migrate?`);
const truncate = `TRUNCATE ${rows.map((r) => r.name).join(', ')} RESTART IDENTITY CASCADE`;

beforeEach(async () => {
  await owner.query(truncate);
});

afterAll(async () => {
  setConformancePgDb(undefined);
  await handle.close().catch(() => {});
  await closePostgresPool(owner).catch(() => {});
});
