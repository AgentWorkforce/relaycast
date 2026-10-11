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

  it('still rejects a task-mode capability on a non-action kind', async () => {
    const f = fixture();
    await expect(
      f.beat({ capabilities: [{ name: 'spawn', kind: 'capacity', execution_mode: 'task' } as never] }),
    ).rejects.toMatchObject({ code: 'invalid_task_capability' });
  });
});
