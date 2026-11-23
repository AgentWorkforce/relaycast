/**
 * vitest globalSetup for the PostgreSQL conformance mode: once per run, as the
 * owner, hold the fixture lock, reset the schema and migrate it with the
 * product migrator. Teardown resets the schema and releases the lock. Any
 * failure fails the run.
 */
import { loadBundledPostgresMigrations, runPostgresMigrations } from '../../adapters/postgres/migrate.js';
import { closePostgresPool, openPostgresPool } from '../../adapters/postgres/pool.js';
import { holdFixtureLock, resetSchema } from '../../adapters/postgres/__tests__/fixture.js';
import { CONFORMANCE_PG_SCHEMA, conformancePgConfig } from './conformancePgEnv.js';

export default async function setup(): Promise<() => Promise<void>> {
  const runtime = conformancePgConfig('runtime');
  const owner = openPostgresPool(conformancePgConfig('owner'));
  let release: (() => Promise<void>) | undefined;
  try {
    release = await holdFixtureLock(owner);
    await resetSchema(owner);
    await runPostgresMigrations(owner, {
      schema: CONFORMANCE_PG_SCHEMA,
      bundled: loadBundledPostgresMigrations(),
      runtimeRole: runtime.user,
    });
  } catch (err) {
    await release?.().catch(() => {});
    await closePostgresPool(owner).catch(() => {});
    throw err;
  }
  return async () => {
    try {
      await resetSchema(owner);
    } finally {
      await release?.().catch(() => {});
      await closePostgresPool(owner);
    }
  };
}
