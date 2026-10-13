import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';
import { claimNodeOffline, markNodeOffline, settleNodeOffline } from '../node.js';
import { rescheduleNodeInvocation } from '../action.js';

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
    INSERT INTO action_invocations(
        id,workspace_id,action_name,status,dispatched_node_id,dispatched_at,dispatch_attempts)
      VALUES ('inv1','ws','echo','dispatched','node1',1000,1);
  `);
  const db = drizzle(sqlite, { schema }) as unknown as EngineDb;
  return { sqlite, db };
}

const seconds = (n: number) => new Date(n * 1000);
const staleExpected = (f: ReturnType<typeof fixture>) => {
  const row = f.sqlite.prepare(
    'SELECT last_heartbeat_at, liveness_revision FROM nodes WHERE id = ?',
  ).get('node1') as { last_heartbeat_at: number | null; liveness_revision: number };
  return {
    lastHeartbeatAt: row.last_heartbeat_at === null ? null : seconds(row.last_heartbeat_at),
    livenessRevision: row.liveness_revision,
  };
};

describe('claimNodeOffline', () => {
  it('claims a stale node atomically and exposes its name', async () => {
    const f = fixture();
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', staleExpected(f));
    expect(claim?.name).toBe('stale-node');
    expect(claim?.claimAt).toBeInstanceOf(Date);
    expect(claim?.claimRevision).toBeGreaterThan(0);
    const row = f.sqlite.prepare('SELECT status, liveness_revision FROM nodes WHERE id = ?').get('node1') as
      { status: string; liveness_revision: number };
    expect(row.status).toBe('offline');
    expect(row.liveness_revision).toBe(claim?.claimRevision);
  });

  it('loses the CAS when a heartbeat landed after the stale read', async () => {
    const f = fixture();
    const expected = staleExpected(f);
    f.sqlite.prepare('UPDATE nodes SET last_heartbeat_at = 2000 WHERE id = ?').run('node1');
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', expected);
    expect(claim).toBeUndefined();
    const row = f.sqlite.prepare('SELECT status, last_heartbeat_at FROM nodes WHERE id = ?').get('node1') as
      { status: string; last_heartbeat_at: number };
    expect(row.status).toBe('online');
    expect(row.last_heartbeat_at).toBe(2000);
  });

  it('loses the CAS when a heartbeat lands in the same timestamp second', async () => {
    const f = fixture();
    const expected = staleExpected(f);
    // The persisted timestamp is unchanged, but the node trigger advances the
    // revision, proving this write followed the stale read.
    f.sqlite.prepare('UPDATE nodes SET last_heartbeat_at = 1000 WHERE id = ?').run('node1');
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', expected);
    expect(claim).toBeUndefined();
  });

  it('loses the CAS when the node already went offline', async () => {
    const f = fixture();
    const expected = staleExpected(f);
    await claimNodeOffline(f.db, 'ws', 'node1', expected);
    const again = await claimNodeOffline(f.db, 'ws', 'node1', expected);
    expect(again).toBeUndefined();
  });
});

describe('settleNodeOffline', () => {
  it('marks pre-claim agents and providers offline while sparing post-claim liveness', async () => {
    const f = fixture();
    const nowSec = Math.floor(Date.now() / 1000);
    f.sqlite.exec(`
      INSERT INTO agents(id,workspace_id,name,token_hash,status,location_type,location_node_id,last_seen)
        VALUES ('ag3','ws','stale-agent','tok3','active','via_node','node1',${nowSec - 120}),
               ('ag4','ws','same-second-agent','tok4','active','via_node','node1',${nowSec});
      INSERT INTO node_providers(
          id,workspace_id,node_id,name,instance_id,capabilities,max_agents,
          active_agents,status,version,last_heartbeat_at,created_at)
        VALUES ('prov2','ws','node1','extra','inst-2','[]',4,0,'online','v1',${nowSec - 120},${nowSec - 120});
    `);
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', staleExpected(f));
    // These writes deliberately preserve the claim's timestamp second. Their
    // revisions still move above the claim boundary and must survive.
    const claimSec = Math.floor(claim!.claimAt.getTime() / 1000);
    f.sqlite.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(claimSec, 'ag1');
    f.sqlite.prepare('UPDATE node_providers SET last_heartbeat_at = ? WHERE id = ?').run(claimSec, 'prov1');
    f.sqlite.prepare(`INSERT INTO action_invocations(
      id,workspace_id,action_name,status,dispatched_node_id,dispatched_at,dispatch_attempts)
      VALUES ('inv2','ws','echo','dispatched','node1',?,1)`).run(claimSec);
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimRevision: claim!.claimRevision,
      before: { status: 'online', name: 'stale-node' },
    });
    const agents = f.sqlite.prepare('SELECT id, status FROM agents ORDER BY id').all() as { id: string; status: string }[];
    // ag1 refreshed after the claim -> survives; ag2 released -> untouched;
    // ag3 and ag4 both predate the claim, even though ag4 shares its second.
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
    const invocations = f.sqlite.prepare(
      'SELECT id, status, dispatched_node_id FROM action_invocations ORDER BY id',
    ).all();
    expect(invocations).toEqual([
      { id: 'inv1', status: 'pending', dispatched_node_id: null },
      { id: 'inv2', status: 'dispatched', dispatched_node_id: 'node1' },
    ]);
  });

  it('is resumable: a retry with the same claim scope still converges stragglers', async () => {
    const f = fixture();
    const staleSec = Math.floor(Date.now() / 1000) - 120;
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', staleExpected(f));
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimRevision: claim!.claimRevision,
      before: { status: 'online', name: 'stale-node' },
    });
    // A straggler appearing later with pre-claim evidence (e.g. a row restored
    // by a racing replica) is still inside the claim scope on retry.
    f.sqlite.exec(`
      INSERT INTO agents(id,workspace_id,name,token_hash,status,location_type,location_node_id,last_seen)
        VALUES ('ag4','ws','late-agent','tok4','active','via_node','node1',${staleSec});
      UPDATE agents SET node_liveness_revision = 0 WHERE id = 'ag4';
    `);
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimRevision: claim!.claimRevision,
    });
    const row = f.sqlite.prepare('SELECT status FROM agents WHERE id = ?').get('ag4') as { status: string };
    expect(row.status).toBe('offline');
  });

  it('settles old rows after a reconnect without clobbering refreshed rows', async () => {
    const f = fixture();
    f.sqlite.exec(`
      INSERT INTO agents(id,workspace_id,name,token_hash,status,location_type,location_node_id,last_seen)
        VALUES ('ag3','ws','stale-agent','tok3','active','via_node','node1',1000);
      INSERT INTO node_providers(
          id,workspace_id,node_id,name,instance_id,capabilities,max_agents,
          active_agents,status,version,last_heartbeat_at,created_at)
        VALUES ('prov2','ws','node1','extra','inst-2','[]',4,0,'online','v1',1000,1000);
    `);
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', staleExpected(f));
    const sameSecond = Math.floor(claim!.claimAt.getTime() / 1000);
    f.sqlite.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(sameSecond, 'ag1');
    f.sqlite.prepare('UPDATE node_providers SET status = ?, last_heartbeat_at = ? WHERE id = ?')
      .run('online', sameSecond, 'prov1');
    f.sqlite.prepare('UPDATE nodes SET status = ?, last_heartbeat_at = ? WHERE id = ?')
      .run('online', sameSecond, 'node1');
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimRevision: claim!.claimRevision,
      before: { status: 'online', name: 'stale-node' },
    });
    const agents = f.sqlite.prepare('SELECT id, status FROM agents ORDER BY id').all() as { id: string; status: string }[];
    expect(agents).toEqual([
      { id: 'ag1', status: 'active' },
      { id: 'ag2', status: 'released' },
      { id: 'ag3', status: 'offline' },
    ]);
    const providers = f.sqlite.prepare('SELECT id, status FROM node_providers ORDER BY id').all() as { id: string; status: string }[];
    expect(providers).toEqual([
      { id: 'prov1', status: 'online' },
      { id: 'prov2', status: 'offline' },
    ]);
  });

  it('does not let a selected pre-claim rescheduler overwrite a post-claim dispatch', async () => {
    const f = fixture();
    const [stale] = await f.db
      .select()
      .from(schema.actionInvocations)
      .where(eq(schema.actionInvocations.id, 'inv1'));
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', staleExpected(f));
    // A new dispatch wins after the lost-node scan selected the old row. Its
    // trigger-stamped revision is above the claim boundary even when the wall
    // clock shares the same SQLite second.
    f.sqlite.prepare(`
      UPDATE action_invocations
      SET status = 'dispatched', dispatched_node_id = 'node1', dispatched_at = ?
      WHERE id = 'inv1'
    `).run(Math.floor(claim!.claimAt.getTime() / 1000));

    expect(await rescheduleNodeInvocation(f.db, registry, stale!, {
      expectedNodeLivenessRevision: stale!.nodeLivenessRevision,
    })).toBe(false);

    const winner = f.sqlite.prepare(`
      SELECT status, dispatched_node_id, node_liveness_revision
      FROM action_invocations WHERE id = 'inv1'
    `).get() as { status: string; dispatched_node_id: string | null; node_liveness_revision: number };
    expect(winner).toEqual({
      status: 'dispatched',
      dispatched_node_id: 'node1',
      node_liveness_revision: claim!.claimRevision + 1,
    });
  });

  it('suppresses the stale offline event when a reconnect wins first', async () => {
    const f = fixture();
    const claim = await claimNodeOffline(f.db, 'ws', 'node1', staleExpected(f));
    f.sqlite.prepare('UPDATE nodes SET status = ?, last_heartbeat_at = ? WHERE id = ?')
      .run('online', Math.floor(claim!.claimAt.getTime() / 1000), 'node1');
    const published: unknown[] = [];
    await settleNodeOffline(f.db, registry, 'ws', 'node1', {
      claimRevision: claim!.claimRevision,
      before: { status: 'online', name: 'stale-node' },
      reason: 'liveness_timeout',
      deps: {
        db: f.db,
        realtime: { publishToWorkspaceStream: async (event: unknown) => { published.push(event); } },
        webhookQueue: { send: async () => undefined },
      } as never,
    });
    expect(f.sqlite.prepare("SELECT type FROM workspace_events WHERE type = 'node.status.offline'").all()).toEqual([]);
    expect(published).toEqual([]);
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
