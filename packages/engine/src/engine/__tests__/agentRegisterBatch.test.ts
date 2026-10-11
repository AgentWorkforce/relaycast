import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import { registerAgentViaNode } from '../node.js';
import type { FleetAgentRegisterMessage } from '@relaycast/types';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

/**
 * `agent.register` runs under the same 5s node-control liveness deadline whose
 * misses surface as `d1_pressure` on the broker. On D1 every awaited drizzle
 * statement is a separate round-trip — the registration used to issue ~11 of
 * them (tombstone read, node read, provider read, name read, channel read,
 * slot reserve, agent insert, member insert, binding insert, agent update,
 * binding retire). Those statements have no data dependencies beyond rows the
 * reads return, so on a batch-capable handle (D1's `db.batch`) they must
 * collapse into a handful of atomic groups instead of one request each.
 */
interface BatchRecordingDb {
  db: EngineDb;
  /** Statement count per `batch()` call, in order. */
  batches: number[];
}

function fixture(nodeSql = '', opts: { dropResponseAfterBatch?: number } = {}) {
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
        '[{"name":"relay:delivery-cursor-v1"}]',4,1,'online','v1',1000,1000);
    INSERT INTO channels(id,workspace_id,name) VALUES ('chan-general','ws','general');
    ${nodeSql}
  `);
  const base = drizzle(sqlite, { schema }) as unknown as EngineDb;
  // A stand-in for D1's `db.batch`: like the real one it receives
  // already-built statements and returns their results in order. D1 batches
  // are atomic; this double executes sequentially, which still exercises the
  // grouping the engine hands the driver (better-sqlite3 has no batch API).
  const batches: number[] = [];
  const db = Object.assign(base, {
    batch: async (statements: readonly PromiseLike<unknown>[]) => {
      const batchIndex = batches.push(statements.length);
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement);
      // Model D1's ambiguous commit: the batch applied, but the reply was
      // dropped before reaching the caller.
      if (batchIndex === opts.dropResponseAfterBatch) {
        throw new Error('D1_ERROR: Network connection lost');
      }
      return results;
    },
  }) as unknown as EngineDb;
  return { sqlite, db, batches };
}

const register = (db: EngineDb, overrides: Partial<FleetAgentRegisterMessage> = {}) =>
  registerAgentViaNode(db, 'ws', 'node1', 'broker', {
    type: 'agent.register',
    id: 'req-1',
    name: 'agent-a',
    ...overrides,
  });

describe('agent.register statement batching', () => {
  it('collapses the registration into batched statement groups', async () => {
    const f = fixture();
    const reply = await register(f.db);
    expect(reply.agent_id).toBeTruthy();
    expect(reply.delivery_ack_seq).toBeDefined();
    // Reads (tombstone, node, provider, name, channel) then admission
    // (reserve + insert) then landing (member + binding + move + retire):
    // three requests total on a batch-capable handle.
    expect(f.batches).toEqual([5, 2, 4]);
    // And the rows actually landed.
    const agent = f.sqlite.prepare('SELECT id, location_node_id, provider_name, status FROM agents WHERE workspace_id = ? AND name = ?')
      .get('ws', 'agent-a') as { id: string; location_node_id: string; provider_name: string; status: string };
    expect(agent.location_node_id).toBe('node1');
    expect(agent.provider_name).toBe('broker');
    const binding = f.sqlite.prepare('SELECT status FROM agent_node_bindings WHERE agent_id = ? AND node_id = ?')
      .get(agent.id, 'node1') as { status: string };
    expect(binding.status).toBe('active');
    const member = f.sqlite.prepare('SELECT role FROM channel_members WHERE agent_id = ? AND channel_id = ?')
      .get(agent.id, 'chan-general') as { role: string };
    expect(member.role).toBe('member');
    const node = f.sqlite.prepare('SELECT active_agents FROM nodes WHERE id = ?').get('node1') as { active_agents: number };
    expect(node.active_agents).toBe(1);
  });

  it('still rejects a name conflict without charging the node a slot', async () => {
    const f = fixture(`INSERT INTO agents(id,workspace_id,name,handle,type,token_hash,status)
      VALUES ('agent-taken','ws','agent-a','@agent-a','agent','tok','active');`);
    await expect(register(f.db)).rejects.toMatchObject({ code: 'agent_already_exists' });
    const node = f.sqlite.prepare('SELECT active_agents FROM nodes WHERE id = ?').get('node1') as { active_agents: number };
    expect(node.active_agents).toBe(0);
    const count = f.sqlite.prepare('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ?').get('ws') as { n: number };
    expect(count.n).toBe(1);
  });

  it('still refuses a full node and leaves no ghost agent behind', async () => {
    const f = fixture(`UPDATE nodes SET max_agents = 1, active_agents = 1 WHERE id = 'node1';`);
    await expect(register(f.db)).rejects.toMatchObject({ code: 'node_capacity_exceeded' });
    const agents = f.sqlite.prepare('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ?').get('ws') as { n: number };
    expect(agents.n).toBe(0);
    const node = f.sqlite.prepare('SELECT active_agents FROM nodes WHERE id = ?').get('node1') as { active_agents: number };
    expect(node.active_agents).toBe(1);
  });

  it('still skips the general membership when the broker opts out', async () => {
    const f = fixture();
    await register(f.db, { auto_join_general: false });
    const member = f.sqlite.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').get('chan-general') as { n: number };
    expect(member.n).toBe(0);
  });

  it('recovers a committed admission whose batch response was lost', async () => {
    // D1 can commit a batch and then drop its reply. The admission group
    // (batch 2) applies the slot reserve and the identity insert, then the
    // response is lost — registration must probe the generated id, finish
    // landing, and return the token instead of erroring and stranding the
    // agent behind a permanent agent_already_exists.
    const f = fixture('', { dropResponseAfterBatch: 2 });
    const reply = await register(f.db);
    expect(reply.agent_id).toBeTruthy();
    const agent = f.sqlite.prepare('SELECT id, location_node_id FROM agents WHERE workspace_id = ? AND name = ?')
      .get('ws', 'agent-a') as { id: string; location_node_id: string };
    expect(agent.id).toBe(reply.agent_id);
    const binding = f.sqlite.prepare('SELECT status FROM agent_node_bindings WHERE agent_id = ? AND node_id = ?')
      .get(agent.id, 'node1') as { status: string };
    expect(binding.status).toBe('active');
    const node = f.sqlite.prepare('SELECT active_agents FROM nodes WHERE id = ?').get('node1') as { active_agents: number };
    expect(node.active_agents).toBe(1);
  });
});
