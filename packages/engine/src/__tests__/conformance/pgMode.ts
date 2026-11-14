/**
 * PostgreSQL conformance mode state, shared by the pg setup file and the
 * harness inside one test worker. Unset (SQLite) unless the pg setup file of
 * vitest.conformance-pg.config.ts installed a verified runtime pool.
 *
 * The setup file publishes the one verified runtime pool (and the owner pool,
 * for test-only DDL); every stack builds its own engine handle over that pool
 * with {@link conformancePgDb}, so per-handle mutations (a stripped
 * `withTransaction`, a fake `batch()`, an injected builder failure) and state
 * keyed on the handle object (credential configuration, background tasks) stay
 * with the test that made them.
 */
import type pg from 'pg';
import { buildPostgresEngineDb, type PostgresEngineDb } from '../../adapters/postgres/engineDb.js';

let runtimePool: pg.Pool | undefined;
let ownerPool: pg.Pool | undefined;

export function setConformancePgPools(pools: { runtime: pg.Pool; owner: pg.Pool } | undefined): void {
  runtimePool = pools?.runtime;
  ownerPool = pools?.owner;
}

/** True when this worker runs the conformance suite against PostgreSQL. */
export function isConformancePgMode(): boolean {
  return runtimePool !== undefined;
}

/**
 * A fresh engine handle over the verified PostgreSQL runtime pool (a new
 * drizzle object each call, sharing the pool); undefined in SQLite mode.
 */
export function conformancePgDb(): PostgresEngineDb | undefined {
  return runtimePool ? buildPostgresEngineDb(runtimePool) : undefined;
}

/**
 * The owner-role pool, for test-only DDL (fault-injection triggers) in pg
 * mode. Throws in SQLite mode. The runtime never holds owner credentials.
 */
export function conformancePgOwner(): pg.Pool {
  if (!ownerPool) throw new Error('conformancePgOwner(): not in PostgreSQL conformance mode');
  return ownerPool;
}
