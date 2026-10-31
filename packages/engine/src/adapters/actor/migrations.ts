import { planMigrations } from '../../db/migrationPlan.js';
import type { ActorSql } from './database.js';
import { ACTOR_MIGRATIONS, ACTOR_MIGRATION_SUPERSESSIONS } from './migrations.generated.js';

const TRACKING_TABLE = '_engine_migrations';
const statementsByFile = new Map(ACTOR_MIGRATIONS);
const files = [...statementsByFile.keys()];
const required = planMigrations(files, new Set(), ACTOR_MIGRATION_SUPERSESSIONS).length;

/**
 * Apply the engine's bundled migrations to an actor database, statement by
 * statement, recording each file in `_engine_migrations` (the same tracking
 * table as the Node adapter).
 *
 * There is no transaction to open: the writes commit with the actor call (or
 * constructor) they run in, and roll back with it. A rolled-back first call
 * therefore leaves the schema unapplied, so every call checks the count
 * first, a single indexed query once the schema is current.
 */
export function applyActorMigrations(sql: ActorSql): { applied: string[] } {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const [{ count }] = sql.exec(`SELECT COUNT(*) AS count FROM ${TRACKING_TABLE}`) as { count: number }[];
  if (count >= required) return { applied: [] };

  const done = new Set(
    (sql.exec(`SELECT name FROM ${TRACKING_TABLE}`) as { name: string }[]).map((row) => row.name),
  );
  const applied: string[] = [];
  for (const file of planMigrations(files, done, ACTOR_MIGRATION_SUPERSESSIONS)) {
    for (const statement of statementsByFile.get(file)!) sql.exec(statement);
    sql.exec(`INSERT INTO ${TRACKING_TABLE} (name, applied_at) VALUES (?, ?)`, file, Math.floor(Date.now() / 1000));
    applied.push(file);
  }
  return { applied };
}
