import { planMigrations } from '../../db/migrationPlan.js';
import type { ActorSql } from './database.js';
import { ACTOR_MIGRATIONS, ACTOR_MIGRATION_SUPERSESSIONS } from './migrations.generated.js';

/** The same tracking table as the Node adapter. */
export const ACTOR_MIGRATIONS_TABLE = '_engine_migrations';
const statementsByFile = new Map(ACTOR_MIGRATIONS);
const files = [...statementsByFile.keys()];

function recorded(sql: ActorSql): Set<string> {
  return new Set((sql.exec(`SELECT name FROM ${ACTOR_MIGRATIONS_TABLE}`) as { name: string }[]).map((row) => row.name));
}

/**
 * Whether nothing is left to apply: the recorded names against the plan, in
 * one read of the tracking table. (A count would read as current while a
 * database that recorded superseded files still lacks a newer one.) The
 * tracking table must exist.
 */
export function actorMigrationsCurrent(sql: ActorSql): boolean {
  return planMigrations(files, recorded(sql), ACTOR_MIGRATION_SUPERSESSIONS).length === 0;
}

/**
 * Apply the engine's bundled migrations to an actor database, statement by
 * statement, recording each file in the tracking table.
 *
 * There is no transaction to open: the writes commit with the actor call
 * they run in, and roll back with it (see `ensureActorSchema`).
 */
export function applyActorMigrations(sql: ActorSql, options: { trackingTableExists?: boolean } = {}): { applied: string[] } {
  if (!options.trackingTableExists) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${ACTOR_MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  }
  const applied: string[] = [];
  for (const file of planMigrations(files, recorded(sql), ACTOR_MIGRATION_SUPERSESSIONS)) {
    for (const statement of statementsByFile.get(file)!) sql.exec(statement);
    sql.exec(`INSERT INTO ${ACTOR_MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`, file, Math.floor(Date.now() / 1000));
    applied.push(file);
  }
  return { applied };
}
