import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';
import { deliverPendingToNode } from '../delivery.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) handle.sqlite.close(); });

function fixture(history = 10_000, active = 125) {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key');
    INSERT INTO nodes(id,workspace_id,name,token_hash) VALUES ('node','ws','node','node-key');
    INSERT INTO agents(id,workspace_id,name,token_hash,location_type,location_node_id,provider_name)
      VALUES ('agent','ws','recipient','agent-key','via_node','node','provider');
    INSERT INTO channels(id,workspace_id,name) VALUES ('channel','ws','general');
  `);
  const message = sqlite.prepare("INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES (?,'ws','channel','agent','body')");
  const delivery = sqlite.prepare(`INSERT INTO deliveries(id,workspace_id,message_id,agent_id,status,seq,route_node_kind)
    VALUES (?,'ws',?,'agent',?,?,'ws')`);
  sqlite.transaction(() => {
    for (let n = 1; n <= history + active; n++) {
      const id = String(n).padStart(10, '0');
      message.run(id); delivery.run('d' + id, id, n <= history ? 'acked' : 'queued', n);
    }
  })();
  sqlite.prepare('UPDATE agents SET delivery_ack_seq = ? WHERE id = ?').run(history, 'agent');
  sqlite.exec('ANALYZE');
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(sqlite, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }) as unknown as EngineDb;
  const frames: { seq: number }[] = [];
  const send = vi.fn(async (_ws, _node, _provider, frame) => { frames.push(frame); return true; });
  const ready = vi.fn(() => true);
  const registry = { sendToProvider: send, isProviderAgentDeliveryReady: ready } as unknown as NodeConnectionRegistry;
  return { db, sqlite, queries, registry, send, ready, frames };
}

describe('bounded database work with retained history', () => {
  it('replays every page in order using active-mailbox and primary-key seeks', async () => {
    const f = fixture();
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node', { providerName: 'provider' })).toBe(125);
    expect(f.frames.map(frame => frame.seq)).toEqual(Array.from({ length: 125 }, (_, n) => 10_001 + n));
    const pages = f.queries.filter(q => q.sql.includes('INDEXED BY deliveries_agent_seq_unique') && !q.sql.includes('DESC'));
    expect(pages).toHaveLength(3);
    for (const query of pages) {
      expect(query.params.at(-1)).toBe(50);
      const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
      expect(plan).toContain('SEARCH deliveries USING INDEX deliveries_agent_seq_unique');
      expect(plan).not.toContain('USE TEMP B-TREE');
    }
    const hydration = f.queries.filter(q => q.sql.startsWith('select') && q.sql.includes('INDEXED BY sqlite_autoindex_deliveries_1'));
    expect(hydration).toHaveLength(3);
    for (const query of hydration) {
      expect(query.params.length).toBeLessThan(100);
      const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
      expect(plan).toContain('SEARCH deliveries USING INDEX sqlite_autoindex_deliveries_1');
    }
  });

  it('does not overtake a failed lower sequence and resumes it on the next trigger', async () => {
    const f = fixture(0, 125);
    f.send.mockImplementation(async (_ws, _node, _provider, frame) => {
      if (frame.seq === 3) return false;
      f.frames.push(frame); return true;
    });
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node')).toBe(2);
    expect(f.frames.map(frame => frame.seq)).toEqual([1, 2]);
    f.send.mockImplementation(async (_ws, _node, _provider, frame) => { f.frames.push(frame); return true; });
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node')).toBe(125);
  });

  it('advances over settled and expired candidate pages without requiring new indexes', async () => {
    const f = fixture(120, 1);
    f.sqlite.exec("UPDATE agents SET delivery_ack_seq = 0 WHERE id = 'agent'");
    f.sqlite.exec("UPDATE deliveries SET status = 'queued', expires_at = 1 WHERE seq <= 50");
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_deliveries_agent_active_seq','idx_deliveries_id_lookup')").all()).toEqual([]);
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node')).toBe(1);
    expect(f.frames.map(frame => frame.seq)).toEqual([121]);
    const pages = f.queries.filter(q => q.sql.includes('INDEXED BY deliveries_agent_seq_unique') && !q.sql.includes('DESC'));
    expect(pages).toHaveLength(3);
    expect(pages.every(q => q.params.at(-1) === 50)).toBe(true);
    expect(f.sqlite.prepare("SELECT delivery_ack_seq AS seq FROM agents WHERE id='agent'").get()).toEqual({ seq: 0 });
  });

  it('rechecks cumulative ACKs between pages without stranding later work', async () => {
    const f = fixture(0, 125);
    f.send.mockImplementation(async (_ws, _node, _provider, frame) => {
      f.frames.push(frame);
      if (frame.seq === 50) f.sqlite.exec("UPDATE agents SET delivery_ack_seq = 100 WHERE id = 'agent'");
      return true;
    });
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node')).toBe(75);
    expect(f.frames.map(frame => frame.seq)).toEqual([
      ...Array.from({ length: 50 }, (_, n) => n + 1), ...Array.from({ length: 25 }, (_, n) => n + 101),
    ]);
  });

  it('coalesces concurrent triggers and schedules a trailing pass for changed readiness', async () => {
    const f = fixture(0, 1);
    let finish!: () => void;
    f.send.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = () => resolve(true); }));
    const first = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const second = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    expect(second).toBe(first);
    finish();
    await Promise.all([first, second]);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

});
