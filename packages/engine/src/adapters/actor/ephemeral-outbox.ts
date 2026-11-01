import type { ActorSql } from './database.js';

const TABLE = '_actor_outbound';
/** Ephemeral events are presence-grade signals; older ones are dropped, not sent. */
const MAX_AGE_MS = 10 * 60_000;
const DRAIN_BATCH = 100;

export function ensureActorOutboundTable(sql: ActorSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      headers TEXT NOT NULL,
      body TEXT
    )`,
  );
}

/**
 * Best-effort ephemeral http_push events queued during a request. Rows are
 * written in the actor call, so a rolled-back call never sends them; the
 * actor alarm sends each once, matching the engine's best-effort contract for
 * these events (no delivery row, no retry).
 */
export class ActorEphemeralOutbox {
  constructor(
    private readonly sql: ActorSql,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  async enqueue(request: Request): Promise<void> {
    const body = request.body ? await request.text() : null;
    this.sql.exec(
      `INSERT INTO ${TABLE} (created_at, method, url, headers, body) VALUES (?, ?, ?, ?, ?)`,
      Date.now(),
      request.method,
      request.url,
      JSON.stringify([...request.headers]),
      body,
    );
  }

  async drain(): Promise<void> {
    this.sql.exec(`DELETE FROM ${TABLE} WHERE created_at < ?`, Date.now() - MAX_AGE_MS);
    for (;;) {
      const rows = this.sql.exec(
        `DELETE FROM ${TABLE} WHERE id IN (SELECT id FROM ${TABLE} ORDER BY id LIMIT ?)
         RETURNING method, url, headers, body`,
        DRAIN_BATCH,
      ) as { method: string; url: string; headers: string; body: string | null }[];
      if (rows.length === 0) return;
      await Promise.allSettled(rows.map(async (row) => {
        const response = await this.fetch(row.url, {
          method: row.method,
          headers: JSON.parse(row.headers) as [string, string][],
          body: row.body,
          signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
      }));
      if (rows.length < DRAIN_BATCH) return;
    }
  }
}
