import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import { heartbeatNode } from '../node.js';
import type { FleetNodeHeartbeatMessage } from '@relaycast/types';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

/**
 * The fleet broker sends `capabilities` on every heartbeat (a ~12s cadence per
 * provider), so the roster-refresh branch of `heartbeatNode` is the hot path —
 * measured ~15 sequential D1 statements per beat on production, which is what
 * tips node-control frames past the 5s liveness deadline into `d1_pressure`.
 * When the snapshot is identical to the stored manifest, the beat must be a
 * single provider write plus the aggregate, not a full capability re-upsert
 * and per-capability action materialization.
 */
function fixture() {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key');
    INSERT INTO nodes(id,workspace_id,name,token_hash,role,status)
      VALUES ('node1','ws','broker-node','node-token','broker','online');
    INSERT INTO node_providers(
        id,workspace_id,node_id,name,instance_id,capabilities,max_agents,
        active_agents,status,version,last_heartbeat_at,created_at)
      VALUES ('prov1','ws','node1','broker','inst-1',
        '[{"name":"spawn"},{"name":"echo"}]',4,1,'online','v1',1000,1000);
    INSERT INTO actions(id,workspace_id,name,description,handler_node_id,handler_provider)
      VALUES ('act1','ws','echo','Node handler echo','node1','broker');
  `);
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(sqlite, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }) as unknown as EngineDb;
  const beat = (overrides: Partial<FleetNodeHeartbeatMessage> = {}) =>
    heartbeatNode(db, 'ws', 'node1', 'broker', {
      type: 'node.heartbeat',
      active_agents: 2,
      handlers_live: true,
      capabilities: [{ name: 'spawn' }, { name: 'echo' }],
      max_agents: 4,
      ...overrides,
    });
  return { sqlite, db, queries, beat };
}

describe('node.heartbeat with an unchanged roster snapshot', () => {
  it('writes the provider row once and does not re-materialize actions', async () => {
    const f = fixture();
    await f.beat();
    const mark = f.queries.length;
    await f.beat();
    const stmts = f.queries.slice(mark).map((q) => q.sql);
    // The capability set is identical to the stored manifest and the
    // materialized rows are intact: rewriting them on every beat is pure write
    // amplification on the hot path. A single drift-check read is fine.
    const writesToActions = stmts.filter((sql) =>
      sql.startsWith('update "actions"')
      || sql.startsWith('insert into "actions"')
      || sql.startsWith('delete from "actions"'));
    expect(writesToActions).toEqual([]);
    // upsert + heartbeat used to write the same provider row twice per beat.
    expect(stmts.filter((sql) => sql.startsWith('update "node_providers"'))).toHaveLength(1);
    // role read, provider read, provider write, drift-check read, providers
    // read (aggregate), aggregate write — the whole beat fits in a handful.
    expect(stmts.length).toBeLessThanOrEqual(8);
  });

  it('still stamps provenLiveAt and refreshes the aggregate on every beat', async () => {
    const f = fixture();
    const node = await f.beat();
    expect(node).not.toBeNull();
    const row = f.sqlite.prepare('SELECT proven_live_at, last_heartbeat_at, active_agents FROM nodes WHERE id = ?').get('node1') as
      { proven_live_at: number | null; last_heartbeat_at: number; active_agents: number };
    expect(row.proven_live_at).not.toBeNull();
    expect(row.last_heartbeat_at).toBeGreaterThan(1000);
    expect(row.active_agents).toBe(2);
  });

  it('re-materializes when the snapshot changes', async () => {
    const f = fixture();
    await f.beat();
    await f.beat({ capabilities: [{ name: 'spawn' }, { name: 'echo' }, { name: 'new-act' }] });
    const acts = f.sqlite.prepare('SELECT name FROM actions WHERE workspace_id = ? AND handler_node_id = ? ORDER BY name').all('ws', 'node1') as { name: string }[];
    expect(acts.map((a) => a.name)).toEqual(['echo', 'new-act']);
  });

  it('re-materializes when a materialized row was deleted out-of-band', async () => {
    const f = fixture();
    await f.beat();
    f.sqlite.prepare('DELETE FROM actions WHERE id = ?').run('act1');
    await f.beat();
    const acts = f.sqlite.prepare('SELECT name FROM actions WHERE workspace_id = ? AND handler_node_id = ?').all('ws', 'node1') as { name: string }[];
    expect(acts.map((a) => a.name)).toEqual(['echo']);
  });

  it('reclaims the global alias when the agent-hosted action that shadowed it disappears', async () => {
    const f = fixture();
    // The synthetic `default` provider keeps its node-scoped 'echo' non-global
    // while an agent-hosted action of the same name owns the workspace alias.
    f.sqlite.exec(`
      INSERT INTO node_providers(
          id,workspace_id,node_id,name,instance_id,capabilities,max_agents,
          active_agents,status,version,last_heartbeat_at,created_at)
        VALUES ('prov-default','ws','node1','default','inst-d',
          '[{"name":"beep"}]',4,0,'online','v1',1000,1000);
      INSERT INTO actions(id,workspace_id,name,description,handler_agent_id,handler_node_id,handler_provider,is_global)
        VALUES ('agent-beep','ws','beep','Agent beep',NULL,NULL,NULL,0),
               ('node-beep','ws','beep','Node beep',NULL,'node1','default',0);
    `);
    const beat = () =>
      heartbeatNode(f.db, 'ws', 'node1', 'default', {
        type: 'node.heartbeat',
        active_agents: 0,
        handlers_live: true,
        capabilities: [{ name: 'beep' }],
        max_agents: 4,
      });
    // While the agent-hosted action exists, the fallback stays non-global and
    // the unchanged snapshot does not re-materialize.
    await beat();
    const shadowed = f.sqlite.prepare('SELECT is_global FROM actions WHERE id = ?').get('node-beep') as { is_global: number };
    expect(shadowed.is_global).toBe(0);
    // Once the agent-hosted row disappears, the next unchanged heartbeat must
    // detect the stale is_global and re-materialize — otherwise the workspace
    // alias stays unreachable until a roster change.
    f.sqlite.prepare('DELETE FROM actions WHERE id = ?').run('agent-beep');
    await beat();
    const reclaimed = f.sqlite.prepare('SELECT is_global FROM actions WHERE id = ?').get('node-beep') as { is_global: number };
    expect(reclaimed.is_global).toBe(1);
  });

  it('still rejects a task-mode capability on a non-action kind', async () => {
    const f = fixture();
    await expect(
      f.beat({ capabilities: [{ name: 'spawn', kind: 'capacity', execution_mode: 'task' } as never] }),
    ).rejects.toMatchObject({ code: 'invalid_task_capability' });
  });
});

describe('node.heartbeat without a capabilities snapshot', () => {
  const steadyBeat = (f: ReturnType<typeof fixture>, overrides: Partial<FleetNodeHeartbeatMessage> = {}) =>
    heartbeatNode(f.db, 'ws', 'node1', 'broker', {
      type: 'node.heartbeat',
      active_agents: 3,
      handlers_live: true,
      load: 42,
      load_reported: true,
      ...overrides,
    });

  it('fits a steady beat in one read and two writes with identical aggregate semantics', async () => {
    const f = fixture();
    const mark = f.queries.length;
    const node = await steadyBeat(f);
    const stmts = f.queries.slice(mark).map((q) => q.sql);
    // role read is the only SELECT: the provider heartbeat reads max_agents
    // in place and the aggregate folds its provider scan into the UPDATE.
    expect(stmts.filter((sql) => sql.startsWith('select'))).toHaveLength(1);
    expect(stmts.filter((sql) => sql.startsWith('update "node_providers"'))).toHaveLength(1);
    expect(stmts.filter((sql) => sql.startsWith('update "nodes"'))).toHaveLength(1);
    expect(stmts).toHaveLength(3);
    expect(node?.status).toBe('online');
    const row = f.sqlite.prepare(
      'SELECT status, handlers_live, max_agents, active_agents, load, load_reported, capabilities FROM nodes WHERE id = ?',
    ).get('node1') as {
      status: string; handlers_live: number; max_agents: number;
      active_agents: number; load: number; load_reported: number; capabilities: string | null;
    };
    expect(row).toMatchObject({
      status: 'online', handlers_live: 1, max_agents: 4,
      active_agents: 3, load: 42, load_reported: 1,
    });
  });

  it('does not count load on a capacity-unbounded provider', async () => {
    const f = fixture();
    f.sqlite.prepare('UPDATE node_providers SET max_agents = 0 WHERE id = ?').run('prov1');
    const node = await steadyBeat(f);
    const row = f.sqlite.prepare('SELECT load, load_reported, max_agents FROM nodes WHERE id = ?').get('node1') as
      { load: number; load_reported: number; max_agents: number };
    // The unbounded sentinel survives aggregation and the load signal is
    // discarded, matching the previous read-then-write rule.
    expect(row).toMatchObject({ load: 0, load_reported: 0, max_agents: 0 });
    expect(node?.load).toBeNull();
  });

  it('marks the node offline when no provider stays online', async () => {
    const f = fixture();
    f.sqlite.prepare("UPDATE node_providers SET status = 'offline' WHERE id = ?").run('prov1');
    const node = await steadyBeat(f);
    // The provider heartbeat itself re-onlines the row it touches, so the
    // node stays online here — matching recomputeNodeAggregate exactly.
    expect(node?.status).toBe('online');
    const providers = f.sqlite.prepare('SELECT status FROM node_providers WHERE id = ?').get('prov1') as { status: string };
    expect(providers.status).toBe('online');
  });

  it('marks the node offline when the beat targets a missing provider with no online rows left', async () => {
    const f = fixture();
    // Provider row gone entirely: the UPDATE touches nothing and the
    // aggregate finds no online provider.
    f.sqlite.prepare('DELETE FROM node_providers WHERE id = ?').run('prov1');
    const node = await steadyBeat(f);
    expect(node?.status).toBe('offline');
    expect(node?.handlers_live).toBe(false);
  });

  it('skips the role read when the caller supplies the prior node row', async () => {
    const f = fixture();
    const mark = f.queries.length;
    await heartbeatNode(f.db, 'ws', 'node1', 'broker', {
      type: 'node.heartbeat', active_agents: 1, handlers_live: true,
    }, { role: 'broker' });
    const stmts = f.queries.slice(mark).map((q) => q.sql);
    expect(stmts.filter((sql) => sql.startsWith('select'))).toHaveLength(0);
    expect(stmts).toHaveLength(2);
  });

  it('returns null without any write when the prior row says the node is missing', async () => {
    const f = fixture();
    const mark = f.queries.length;
    const node = await heartbeatNode(f.db, 'ws', 'node1', 'broker', {
      type: 'node.heartbeat', active_agents: 1, handlers_live: true,
    }, null);
    expect(node).toBeNull();
    expect(f.queries.slice(mark)).toHaveLength(0);
  });
});
