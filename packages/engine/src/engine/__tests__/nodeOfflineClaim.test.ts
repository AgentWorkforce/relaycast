import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';
import { claimNodeOffline, markNodeOffline, settleNodeOffline } from '../node.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

/**
 * The cloud NodeDO holds control admission on a liveness fence while the
 * offline transition runs. Splitting the transition into a one-statement CAS
 * claim and a claim-scoped settle tail lets the fence cover the claim only —
 * a reconnect's registration must never be clobbered by settle effects for a
 * liveness epoch it refreshed past.
 */
const registry = {
  sendToNode: async () => false,
  sendToProvider: async () => false,
  sendAuthorizedActionToProvider: async () => false,
  drainNode: async () => undefined,
  disconnectNode: async () => undefined,
} as unknown as NodeConnectionRegistry;

function fixture() {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key');
    INSERT INTO nodes(id,workspace_id,name,token_hash,role,status,last_heartbeat_at)
      VALUES ('node1','ws','stale-node','node-token','broker','online',1000);
    INSERT INTO node_providers(
        id,workspace_id,node_id,name,instance_id,capabilities,max_agents,
        active_agents,status,version,last_heartbeat_at,created_at)
      VALUES ('prov1','ws','node1','broker','inst-1','[]',4,1,'online','v1',1000,1000);
    INSERT INTO agents(id,workspace_id,name,token_hash,status,location_type,location_node_id,last_seen)
      VALUES ('ag1','ws','old-agent','tok1','active','via_node','node1',1000),
             ('ag2','ws','released-agent','tok2','released','via_node','node1',1000);
  `);
  const db = drizzle(sqlite, { schema }) as unknown as EngineDb;
  return { sqlite, db };
}

const seconds = (n: number) => new Date(n * 1000);

describe('claimNodeOffline', () => {
  it('claims a stale node atomically and exposes its name', async () => {
    const f = fixture();
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    expect(claim?.name).toBe('stale-node');
    expect(claim?.claimAt).toBeInstanceOf(Date);
    const row = f.sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get('node1') as { status: string };
    expect(row.status).toBe('offline');
  });

  it('loses the CAS when a heartbeat landed after the stale read', async () => {
    const f = fixture();
    f.sqlite.prepare('UPDATE nodes SET last_heartbeat_at = 2000 WHERE id = ?').run('node1');
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    expect(claim).toBeUndefined();
    const row = f.sqlite.prepare('SELECT status, last_heartbeat_at FROM nodes WHERE id = ?').get('node1') as
      { status: string; last_heartbeat_at: number };
    expect(row.status).toBe('online');
    expect(row.last_heartbeat_at).toBe(2000);
  });

  it('loses the CAS when the node already went offline', async () => {
    const f = fixture();
    await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    const again = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    expect(again).toBeUndefined();
  });
});

describe('settleNodeOffline', () => {
  it('marks pre-claim agents and providers offline while sparing post-claim liveness', async () => {
    const f = fixture();
    // Liveness evidence is expressed relative to the real claim instant the
    // CAS stamps into last_heartbeat_at.
    const nowSec = Math.floor(Date.now() / 1000);
    // A reconnect-registered agent and a re-heartbeated provider both carry
    // liveness newer than the claim; the stale rows keep pre-claim evidence.
    f.sqlite.prepare(`UPDATE agents SET last_seen = ${nowSec + 120} WHERE id = 'ag1'`).run();
    f.sqlite.exec(`
      INSERT INTO agents(id,workspace_id,name,token_hash,status,location_type,location_node_id,last_seen)
        VALUES ('ag3','ws','stale-agent','tok3','active','via_node','node1',${nowSec - 120}),
               ('ag4','ws','same-second-agent','tok4','active','via_node','node1',${nowSec});
      UPDATE node_providers SET last_heartbeat_at = ${nowSec + 120} WHERE id = 'prov1';
      INSERT INTO node_providers(
          id,workspace_id,node_id,name,instance_id,capabilities,max_agents,
          active_agents,status,version,last_heartbeat_at,created_at)
        VALUES ('prov2','ws','node1','extra','inst-2','[]',4,0,'online','v1',${nowSec - 120},${nowSec - 120});
    `);
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimAt: claim!.claimAt,
      before: { status: 'online', name: 'stale-node' },
    });
    const agents = f.sqlite.prepare('SELECT id, status FROM agents ORDER BY id').all() as { id: string; status: string }[];
    // ag1 refreshed past the claim -> survives; ag2 released -> untouched;
    // ag3 predates the claim -> taken offline; ag4's same-second evidence is
    // not provably newer than the claim -> also torn down.
    expect(agents).toEqual([
      { id: 'ag1', status: 'active' },
      { id: 'ag2', status: 'released' },
      { id: 'ag3', status: 'offline' },
      { id: 'ag4', status: 'offline' },
    ]);
    const providers = f.sqlite.prepare('SELECT id, status FROM node_providers ORDER BY id').all() as { id: string; status: string }[];
    expect(providers).toEqual([
      { id: 'prov1', status: 'online' },
      { id: 'prov2', status: 'offline' },
    ]);
  });

  it('is resumable: a retry with the same claim scope still converges stragglers', async () => {
    const f = fixture();
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    await settleNodeOffline(f.db, registry, 'ws', 'node1', { claimAt: claim!.claimAt, before: { status: 'online', name: 'stale-node' } });
    // A straggler appearing later with pre-claim evidence (e.g. a row restored
    // by a racing replica) is still inside the claim scope on retry.
    f.sqlite.exec(`
      INSERT INTO agents(id,workspace_id,name,token_hash,status,location_type,location_node_id,last_seen)
        VALUES ('ag4','ws','late-agent','tok4','active','via_node','node1',${staleSec});
    `);
    await settleNodeOffline(f.db, registry, 'ws', 'node1', { claimAt: claim!.claimAt });
    const row = f.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get('ag4') as { status: string };
    expect(row.status).toBe('offline');
  });

  it('is a no-op when the node reconnected after the claim', async () => {
    const f = fixture();
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    // A reconnect's registration/heartbeat flips the row online again — the
    // stale claim's tail must not tear down the new liveness epoch.
    f.sqlite.prepare(`UPDATE nodes SET status = 'online', last_heartbeat_at = ${Math.floor(Date.now() / 1000) + 120} WHERE id = 'node1'`).run();
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimAt: claim!.claimAt,
      before: { status: 'online', name: 'stale-node' },
    });
    const agents = f.sqlite.prepare('SELECT id, status FROM agents ORDER BY id').all() as { id: string; status: string }[];
    expect(agents).toEqual([
      { id: 'ag1', status: 'active' },
      { id: 'ag2', status: 'released' },
    ]);
    const providers = f.sqlite.prepare('SELECT id, status FROM node_providers ORDER BY id').all() as { id: string; status: string }[];
    expect(providers).toEqual([{ id: 'prov1', status: 'online' }]);
  });

  it('is a no-op when a newer liveness write moved the heartbeat past the claim', async () => {
    const f = fixture();
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', { lastHeartbeatAt: seconds(1000) });
    // The node stayed offline but a newer heartbeat landed (e.g. a racing
    // transition wrote past the claim) — the claim epoch is no longer current.
    f.sqlite.prepare(`UPDATE nodes SET last_heartbeat_at = ${Math.floor(Date.now() / 1000) + 120} WHERE id = 'node1'`).run();
    await settleNodeOffline(f.db, registry, 'ws', 'node1', { claimAt: claim!.claimAt });
    const row = f.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get('ag1') as { status: string };
    expect(row.status).toBe('active');
  });
});

describe('markNodeOffline', () => {
  it('keeps the legacy unconditional sweep for serialized callers', async () => {
    const f = fixture();
    // Even a post-transition-refresh-looking row is swept: serialized callers
    // (provider disconnect, deregister) already exclude concurrent register.
    f.sqlite.prepare(`UPDATE agents SET last_seen = 9999999999 WHERE id = 'ag1'`).run();
    await markNodeOffline(f.db, registry, 'ws', 'node1');
    const agents = f.sqlite.prepare('SELECT id, status FROM agents ORDER BY id').all() as { id: string; status: string }[];
    expect(agents).toEqual([
      { id: 'ag1', status: 'offline' },
      { id: 'ag2', status: 'released' },
    ]);
    const node = f.sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get('node1') as { status: string };
    expect(node.status).toBe('offline');
  });
});
