import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import { registerAgentViaNode } from '../node.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

/**
 * `registerAgentViaNode` runs a migration-tombstone check on every
 * `agent.register`: a legacy spawn invocation cancelled during the provider
 * migration must block re-registration of the same (node, agent-name) tuple.
 * Only rows with `error = 'invocation_origin_unavailable'` can match — a few
 * thousand rows in production — but the query used to seek the whole
 * `status = 'failed'` bucket (~216k rows, ~1.8s per registration on prod).
 * This fixture puts enough failed invocations around the tombstone that the
 * scan is unmistakable in the query plan.
 */
function fixture({ tombstones = 0, failedRows = 5_000 } = {}) {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key');
    INSERT INTO nodes(id,workspace_id,name,token_hash,role,status)
      VALUES ('node1','ws','broker-node','node-token','broker','online');
    INSERT INTO node_providers(id,workspace_id,node_id,name,instance_id)
      VALUES ('prov1','ws','node1','broker','inst-1');
    INSERT INTO channels(id,workspace_id,name) VALUES ('chan1','ws','general');
  `);
  const invocation = sqlite.prepare(`
    INSERT INTO action_invocations(
      id, workspace_id, action_name, invocation_origin, input, status, error,
      dispatched_node_id, dispatched_provider
    ) VALUES (?, 'ws', 'spawn', 'legacy_unknown', ?, 'failed', ?, 'node1', 'broker')
  `);
  sqlite.transaction(() => {
    for (let n = 0; n < failedRows; n++) {
      invocation.run(`inv-${n}`, JSON.stringify({ name: `agent-${n % 97}` }), 'handler_unavailable');
    }
    for (let n = 0; n < tombstones; n++) {
      invocation.run(`doomed-${n}`, JSON.stringify({ name: `doomed-${n}` }), 'invocation_origin_unavailable');
    }
  })();
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(sqlite, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }) as unknown as EngineDb;
  return { sqlite, db, queries };
}

function tombstoneQueryPlan(f: ReturnType<typeof fixture>): string {
  const query = f.queries.find((q) => q.sql.includes('invocation_origin'))!;
  expect(query, 'tombstone check query was not issued').toBeTruthy();
  return JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
}

describe('agent.register spawn tombstone check', () => {
  it('seeks the cancelled-spawn tombstones instead of scanning every failed invocation', async () => {
    const f = fixture();
    const registered = await registerAgentViaNode(f.db, 'ws', 'node1', 'broker', { name: 'fresh-agent' });
    expect(registered.name).toBe('fresh-agent');
    const plan = tombstoneQueryPlan(f);
    expect(plan).toContain('idx_action_invocations_spawn_canceled');
    expect(plan).not.toContain('idx_action_invocations_status_retry_after');
  });

  it('still rejects a re-registration that matches a tombstone', async () => {
    const f = fixture({ tombstones: 2 });
    await expect(
      registerAgentViaNode(f.db, 'ws', 'node1', 'broker', { name: 'doomed-1' }),
    ).rejects.toMatchObject({ code: 'spawn_invocation_canceled' });
  });
});
