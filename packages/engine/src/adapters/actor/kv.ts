import type { KeyValueStore } from '../../ports/kv.js';
import type { ActorSql } from './database.js';

const TABLE = '_actor_kv';

/** Create the KV table. Idempotent; runs with the actor's migrations. */
export function ensureActorKvTable(sql: ActorSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`,
  );
}

/**
 * Key/value store in the actor's own SQLite. Idempotency records and locks
 * written here commit or roll back with the actor call that wrote them, and
 * survive the actor going dormant.
 */
export class ActorKeyValueStore implements KeyValueStore {
  constructor(private readonly sql: ActorSql) {}

  async get(key: string): Promise<string | null> {
    const [row] = this.sql.exec(
      `SELECT value FROM ${TABLE} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      key,
      Date.now(),
    ) as { value: string }[];
    return row?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.sql.exec(
      `INSERT INTO ${TABLE} (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key,
      value,
      expiresAt,
    );
  }

  async delete(key: string): Promise<void> {
    this.sql.exec(`DELETE FROM ${TABLE} WHERE key = ?`, key);
  }

  /** Drop expired entries. Runs from actor maintenance. */
  prune(): void {
    this.sql.exec(`DELETE FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at <= ?`, Date.now());
  }
}
