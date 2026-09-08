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

describe('mainline replay scope and handoff guards', () => {
  it('keeps a distinct result for a trigger arriving during an active replay', async () => {
    const f = fixture(0, 1);
    let finish!: () => void;
    f.send.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = () => resolve(true); }));
    const first = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const second = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    expect(second).not.toBe(first);
    finish();
    await Promise.all([first, second]);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('serializes overlapping node and agent scopes without dropping the trailing scope', async () => {
    const f = fixture(0, 2);
    let finish!: () => void;
    f.send.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = () => resolve(true); }));
    const first = deliverPendingToNode(f.db, f.registry, 'ws', 'node', { agentIds: ['agent'], providerName: 'provider' });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const second = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    expect(second).not.toBe(first);
    await Promise.resolve();
    expect(f.send).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(f.send.mock.calls.map(call => call[3].seq)).toEqual([1, 2, 1, 2]);
  });

  it('reports errors only to their scope and continues queued work after failure', async () => {
    const f = fixture(0, 1);
    let fail!: () => void;
    f.send.mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => {
      fail = () => reject(new Error('first scope failed'));
    }));
    const first = deliverPendingToNode(f.db, f.registry, 'ws', 'node', { agentIds: ['agent'] });
    const firstResult = first.catch(error => error.message);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const second = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    const duplicate = deliverPendingToNode(f.db, f.registry, 'ws', 'node');
    expect(duplicate).toBe(second);
    fail();
    expect(await firstResult).toBe('first scope failed');
    expect(await second).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('rechecks cumulative ACKs after a send within a hydrated page', async () => {
    const f = fixture(0, 4);
    f.send.mockImplementation(async (_ws, _node, _provider, frame) => {
      f.frames.push(frame);
      if (frame.seq === 1) f.sqlite.exec("UPDATE agents SET delivery_ack_seq = 3 WHERE id = 'agent'");
      return true;
    });
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node')).toBe(2);
    expect(f.frames.map(frame => frame.seq)).toEqual([1, 4]);
  });

  it('does not send remaining hydrated rows to the old provider after handoff', async () => {
    const f = fixture(0, 4);
    f.send.mockImplementation(async (_ws, _node, _provider, frame) => {
      f.frames.push(frame);
      f.sqlite.exec("UPDATE agents SET provider_name = 'new-provider' WHERE id = 'agent'");
      return true;
    });
    expect(await deliverPendingToNode(f.db, f.registry, 'ws', 'node')).toBe(1);
    expect(f.frames.map(frame => frame.seq)).toEqual([1]);
  });

});
