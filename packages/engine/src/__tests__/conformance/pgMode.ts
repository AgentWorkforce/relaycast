/**
 * PostgreSQL conformance mode state, shared by the pg setup file and the
 * harness inside one test worker. Unset (SQLite) unless the pg setup file of
 * vitest.conformance-pg.config.ts installed a verified handle.
 */
import type { EngineDb } from '../../ports/database.js';

let pgDb: EngineDb | undefined;

export function setConformancePgDb(db: EngineDb | undefined): void {
  pgDb = db;
}

/** The verified PostgreSQL runtime handle in pg mode; undefined in SQLite mode. */
export function conformancePgDb(): EngineDb | undefined {
  return pgDb;
}
