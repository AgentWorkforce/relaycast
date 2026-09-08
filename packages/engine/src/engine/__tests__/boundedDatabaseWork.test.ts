import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';
import { deliverPendingToNode, fetchDueNodeDeliveryEvents } from '../delivery.js';
import { pruneExpired } from '../retention.js';

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
    const pages = f.queries.filter(q => q.sql.includes('INDEXED BY idx_deliveries_agent_active_seq'));
    expect(pages).toHaveLength(3);
    for (const query of pages) {
      expect(query.params.at(-1)).toBe(50);
      const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
      expect(plan).toContain('SEARCH deliveries USING INDEX idx_deliveries_agent_active_seq');
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

  it('uses the initial-attempt seek rather than scanning settled history for cron redrive', async () => {
    const f = fixture(10_000, 3);
    expect(await fetchDueNodeDeliveryEvents(f.db)).toHaveLength(3);
    const query = f.queries.find(q => q.sql.includes('INDEXED BY idx_deliveries_initial_due'))!;
    expect(query).toBeDefined();
    const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
    expect(plan).toContain('SEARCH deliveries USING INDEX idx_deliveries_initial_due');
  });

  it('advances retained-only candidate pages durably and never scans active deliveries for retention', async () => {
    const f = fixture();
    f.sqlite.exec(`UPDATE deliveries SET created_at = 1;
      UPDATE workspaces SET retention = '{"delivery_ttl_days":null}'`);
    const opts = { batchLimit: 10, maxBatches: 1 };
    expect((await pruneExpired(f.db, opts)).deliveries).toBe(0);
    const cursor = () => JSON.parse((f.sqlite.prepare("SELECT cursor FROM maintenance_cursors WHERE id = 'retention-v1'").get() as { cursor: string }).cursor);
    expect(cursor().positions.deliveries[1]).toBe('d0000000010');
    // A new handle simulates the next isolate; progress is not process memory.
    const nextDb = drizzle(f.sqlite, { schema }) as unknown as EngineDb;
    await pruneExpired(nextDb, opts);
    expect(cursor().positions.deliveries[1]).toBe('d0000000020');
    const pages = f.queries.filter(q => q.sql.includes('WITH page AS MATERIALIZED'));
    expect(pages).toHaveLength(4); // globally disabled message retention does no candidate scan
    for (const query of pages) {
      expect(query.params.at(-1)).toBe(10);
      expect(f.sqlite.prepare(query.sql).all(...query.params).length).toBeLessThanOrEqual(10);
      expect(query.sql).not.toContain('SELECT *');
    }
  });

  it('makes progress past event high-water rows and wraps without resetting event sequence authority', async () => {
    const f = fixture(0, 0);
    const insert = f.sqlite.prepare("INSERT INTO workspace_events(workspace_id,seq,type,payload,created_at) VALUES (?,?,'test','{}',1)");
    f.sqlite.transaction(() => {
      for (let n = 0; n < 250; n++) insert.run('retained-' + String(n).padStart(3, '0'), 1);
      insert.run('z-target', 1); insert.run('z-target', 2);
    })();
    for (let pass = 0; pass < 6; pass++) await pruneExpired(f.db, { batchLimit: 50, maxBatches: 1 });
    expect(f.sqlite.prepare("SELECT seq FROM workspace_events WHERE workspace_id = 'z-target'").all()).toEqual([{ seq: 2 }]);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_events').get()).toEqual({ n: 251 });
    // Every candidate query stays bounded even though almost every row must remain.
    const eventPages = f.queries.filter(q => q.sql.includes('WITH page AS MATERIALIZED') && q.sql.includes('idx_workspace_events_retention'));
    expect(eventPages).toHaveLength(6);
    for (const query of eventPages.slice(1)) {
      const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
      expect(plan).toContain('SEARCH workspace_events USING COVERING INDEX idx_workspace_events_retention');
    }
  });

  it('wraps a retained-only traversal at its captured fence despite continuous new arrivals', async () => {
    const f = fixture(4, 0);
    f.sqlite.exec(`UPDATE deliveries SET created_at = 1;
      UPDATE workspaces SET retention = '{"delivery_ttl_days":null}'`);
    const opts = { batchLimit: 2, maxBatches: 1 };
    const cursor = () => JSON.parse((f.sqlite.prepare("SELECT cursor FROM maintenance_cursors WHERE id = 'retention-v1'").get() as { cursor: string }).cursor);
    await pruneExpired(f.db, opts);
    expect(cursor().positions.deliveries[1]).toBe('d0000000002');
    expect(cursor().highs.deliveries[1]).toBe('d0000000004');
    f.sqlite.exec(`
      INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES ('0000000005','ws','channel','agent','new');
      INSERT INTO deliveries(id,workspace_id,message_id,agent_id,status,seq,created_at)
        VALUES ('d0000000005','ws','0000000005','agent','acked',5,1);
    `);
    await pruneExpired(f.db, opts);
    expect(cursor().positions.deliveries).toBeUndefined();
    expect(cursor().highs.deliveries).toBeUndefined();
    await pruneExpired(f.db, opts);
    expect(cursor().positions.deliveries[1]).toBe('d0000000002');
    expect(cursor().highs.deliveries[1]).toBe('d0000000005');
  });

  it('checkpoints the next table before yielding to the elapsed run budget', async () => {
    const f = fixture(4, 0);
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const original = f.db.run.bind(f.db);
    vi.spyOn(f.db, 'run').mockImplementation((query) => { clock += 2; return original(query); });
    await pruneExpired(f.db, { maxDurationMs: 1, defaults: { messageTtlDays: 30 } });
    const state = JSON.parse((f.sqlite.prepare("SELECT cursor FROM maintenance_cursors WHERE id = 'retention-v1'").get() as { cursor: string }).cursor);
    expect(state.next).toBe(1);
    expect(f.queries.filter(q => q.sql.includes('WITH page AS MATERIALIZED'))).toHaveLength(1);
  });
});
