import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const handles: Database.Database[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
});

describe('delivery sequence high-water migration', () => {
  it('repairs the full active queue above a collision-free base in FIFO order', () => {
    const sqlite = new Database(':memory:');
    handles.push(sqlite);
    sqlite.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        delivery_ack_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(workspace_id, agent_id, seq)
      );

      INSERT INTO agents (id, workspace_id, delivery_ack_seq) VALUES
        ('agent_affected', 'ws_1', 5),
        ('agent_healthy', 'ws_1', 2),
        ('agent_fully_pruned', 'ws_1', 7);

      INSERT INTO deliveries (id, workspace_id, agent_id, status, seq, created_at) VALUES
        ('terminal_collision', 'ws_1', 'agent_affected', 'acked', 10, 50),
        ('hidden_older', 'ws_1', 'agent_affected', 'queued', 4, 100),
        ('visible_newer', 'ws_1', 'agent_affected', 'delivered', 8, 200),
        ('healthy_active', 'ws_1', 'agent_healthy', 'queued', 4, 100);
    `);

    const migration = readFileSync(
      new URL('../../../db/migrations/0029_delivery_sequence_high_water.sql', import.meta.url),
      'utf8',
    );
    sqlite.exec(migration);

    const repaired = sqlite.prepare(`
      SELECT id, seq
      FROM deliveries
      WHERE agent_id = 'agent_affected' AND status IN ('queued', 'delivered')
      ORDER BY created_at, id
    `).all();
    expect(repaired).toEqual([
      { id: 'hidden_older', seq: 11 },
      { id: 'visible_newer', seq: 12 },
    ]);
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_affected'`).get())
      .toEqual({ delivery_seq: 12 });
    expect(sqlite.prepare(`SELECT seq FROM deliveries WHERE id = 'healthy_active'`).get())
      .toEqual({ seq: 4 });
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_healthy'`).get())
      .toEqual({ delivery_seq: 4 });
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_fully_pruned'`).get())
      .toEqual({ delivery_seq: 7 });

    sqlite.exec(`
      INSERT INTO deliveries (id, workspace_id, agent_id, status, seq, created_at)
      SELECT 'next_delivery', workspace_id, id, 'queued', delivery_seq + 1, 300
      FROM agents
      WHERE id = 'agent_affected';
    `);
    expect(sqlite.prepare(`SELECT seq FROM deliveries WHERE id = 'next_delivery'`).get())
      .toEqual({ seq: 13 });
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_affected'`).get())
      .toEqual({ delivery_seq: 13 });

    sqlite.exec(`
      INSERT INTO deliveries (id, workspace_id, agent_id, status, seq, created_at)
      SELECT 'after_full_prune', workspace_id, id, 'queued', delivery_seq + 1, 300
      FROM agents
      WHERE id = 'agent_fully_pruned';
    `);
    expect(sqlite.prepare(`SELECT seq FROM deliveries WHERE id = 'after_full_prune'`).get())
      .toEqual({ seq: 8 });
  });
});
