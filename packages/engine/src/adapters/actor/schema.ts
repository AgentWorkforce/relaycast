import type { ActorSql } from './database.js';
import { ACTOR_MIGRATIONS_TABLE, applyActorMigrations, actorMigrationsCurrent } from './migrations.js';
import { ACTOR_KV_TABLE } from './kv.js';
import { ACTOR_OUTBOUND_TABLE } from './ephemeral-outbox.js';
import { ACTOR_CREDENTIAL_TAG_TABLE } from './credential-tag.js';
import { ACTOR_SOCKETS_TABLE } from './socket-table.js';
import { ACTOR_IMPORT_CHUNKS_TABLE, ACTOR_IMPORT_TABLE } from './import.js';

/** A table the adapter keeps beside the engine schema, with the statement that creates it. */
export interface ActorTable {
  readonly name: string;
  readonly ddl: string;
}

const ADAPTER_TABLES: readonly ActorTable[] = [
  ACTOR_KV_TABLE,
  ACTOR_OUTBOUND_TABLE,
  ACTOR_CREDENTIAL_TAG_TABLE,
  ACTOR_SOCKETS_TABLE,
  ACTOR_IMPORT_TABLE,
  ACTOR_IMPORT_CHUNKS_TABLE,
];

/**
 * Bring the actor database to the current schema: the engine's bundled
 * migrations and the adapter's own tables.
 *
 * Runs inside an actor call, never in the constructor: durable-actors 0.14.6
 * commits each statement outside `db.transaction` on its own (one persisted
 * write each), while inside the call's transaction the whole schema commits
 * once with the call, and a failed first call rolls it back whole.
 *
 * The check is read-only when the schema is current: one `sqlite_master`
 * read for the tables and one read of the recorded migration names, no DDL. Only
 * what is missing is created. Returns true when nothing had to be done, so
 * the caller can skip the check for the rest of the activation (a schema
 * that was already committed cannot roll back with this call).
 */
export function ensureActorSchema(sql: ActorSql): boolean {
  const names = [ACTOR_MIGRATIONS_TABLE, ...ADAPTER_TABLES.map((table) => table.name)];
  const present = new Set(
    (sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(', ')})`,
      ...names,
    ) as { name: string }[]).map((row) => row.name),
  );
  const migrationsCurrent = present.has(ACTOR_MIGRATIONS_TABLE) && actorMigrationsCurrent(sql);
  const tablesCurrent = ADAPTER_TABLES.every((table) => present.has(table.name));
  if (migrationsCurrent && tablesCurrent) return true;

  if (!migrationsCurrent) applyActorMigrations(sql, { trackingTableExists: present.has(ACTOR_MIGRATIONS_TABLE) });
  for (const table of ADAPTER_TABLES) {
    if (!present.has(table.name)) sql.exec(table.ddl);
  }
  return false;
}
