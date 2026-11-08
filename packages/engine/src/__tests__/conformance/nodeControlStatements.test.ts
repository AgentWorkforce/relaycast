import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brandSqliteEngineDb } from '../../adapters/sqlite-handle.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { handleNodeControlMessage, type WorkspaceDeadlineHolder } from '../../node-control.js';
import { bindAgentToNode, deregisterAgentViaNode, settleNodeOffline, unbindAgentFromNode } from '../../engine/node.js';
import { deleteAgent } from '../../engine/agent.js';
import { sendNodePresenceContext } from '../../engine/nodeContext.js';
import { configureNodeLiveness } from '../../engine/nodeLiveness.js';
import type { EngineDb } from '../../ports/database.js';
import type { PresenceTracker } from '../../ports/presence.js';

/**
 * D1 statements per node control frame, counted at the database handle the
 * frame runs against. Node count, not message volume, is the hosted database's
 * ceiling, so the steady-state frames must stay at their floor: a checkpoint
 * (a heartbeat identical to the last accepted one) renews the durable
 * projection and nothing else, and a changed broker roster never rewrites
 * action rows.
 */

const label = (sql: string) => sql.replace(/\s+/g, ' ').match(/^(select .*? from "\w+"|update "\w+"|insert into "\w+"|delete from "\w+")/)?.[1]
  .replace(/^select .*? from/, 'select from') ?? sql.slice(0, 40);

const presence: PresenceTracker = {
  heartbeat: async () => {},
  disconnect: async () => {},
  getOnline: async () => [],
  explicitlyDisconnected: async () => [],
};

function held(): WorkspaceDeadlineHolder & { value?: { expiresAt: Date | null } } {
  return {
    get() { return this.value; },
    set(expiresAt) { this.value = { expiresAt }; },
  };
}

describe('node control D1 statements per frame', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => { await stack.close(); });

  /**
   * Counts at the connection, so statements a frame issues through the
   * runtime's own handle (drain, completion effects) are counted too.
   */
  function counting() {
    const statements: string[] = [];
    const raw: Array<{ sql: string; params: unknown[] }> = [];
    const sqlite = stack.runtime.handle.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((sql: string) => {
      if (!sql.startsWith('EXPLAIN')) statements.push(label(sql));
      return prepare(sql);
    }) as typeof sqlite.prepare;
    const db = brandSqliteEngineDb(drizzle(sqlite, { schema, logger: { logQuery: (sql, params) => {
      raw.push({ sql, params });
    } } })) as unknown as EngineDb;
    return {
      db,
      raw,
      take() { return statements.splice(0); },
    };
  }

  /** The query plan SQLite picks without table statistics, as on D1. */
  function plan(statement: { sql: string; params: unknown[] }): string {
    const params = statement.params.map((param) => (
      param instanceof Date ? Math.floor(param.getTime() / 1000) : typeof param === 'boolean' ? Number(param) : param
    ));
    return JSON.stringify(stack.runtime.handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...params));
  }

  async function enrollBroker(workspaceKey: string, nodeId: string) {
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name: nodeId, role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'v0' }),
    });
    expect(created.status).toBe(201);
  }

  const brokerCapabilities = [
    { name: 'spawn:claude', kind: 'capacity' },
    { name: 'echo', kind: 'action' },
  ];
  const brokerBeat = (names: string[]) => ({
    v: 1,
    type: 'node.heartbeat',
    provider: { name: 'broker', instance_id: 'i1' },
    name: 'nb',
    node_id: 'nb',
    // The relay broker appends its live-agent roster as a capacity capability.
    capabilities: [...brokerCapabilities, { name: 'agents:live', kind: 'capacity', metadata: { names } }],
    max_agents: 4,
    version: 'v1',
    load: 0,
    active_agents: names.length,
    handlers_live: true,
  });

  it('keeps every steady-state frame at its statement floor', async () => {
    const ws = await createWorkspace(stack.app, 'statements');
    await enrollBroker(ws.workspaceKey, 'nb');
    const { db, take } = counting();
    const deadline = held();
    const sock = new FakeSocket();
    const broker = (frame: Record<string, unknown>, extra: Partial<Parameters<typeof handleNodeControlMessage>[0]> = {}) =>
      handleNodeControlMessage({
        db, registry: stack.runtime.realtime, completionDeps: stack.runtime.deps,
        workspaceId: ws.workspaceId, nodeId: 'nb', socket: sock, workspaceDeadline: deadline,
        raw: JSON.stringify(frame), ...extra,
      });

    await broker({ v: 1, id: 'r', type: 'node.register', name: 'nb', node_id: 'nb', provider: { name: 'broker', instance_id: 'i1' }, capabilities: brokerCapabilities, max_agents: 4, tags: [], version: 'v1', resume_cursor: null });
    const register = take();
    await broker(brokerBeat([]));
    take();
    await broker(brokerBeat(['worker-a']));
    const changedBeat = take();
    await broker(brokerBeat(['worker-a']));
    const unchangedBeat = take();
    await broker(brokerBeat(['worker-a']), { heartbeatCheckpoint: { role: 'broker' } });
    const brokerCheckpoint = take();

    await broker({ v: 1, id: 'a', type: 'agent.register', name: 'worker-a', session_ref: 'pty://a' });
    const agentId = (sock.ofType('reply').at(-1) as { data: { agent_id: string } }).data.agent_id;
    take();
    await broker({ v: 1, id: 'inv', type: 'inventory.sync', agents: [{ agent_id: agentId, name: 'worker-a', session_ref: 'pty://a' }] });
    const inventorySync = take();

    const direct = await registerAgent(stack.app, ws.workspaceKey, 'solo');
    const directNodeId = `node_direct_${direct.agentId}`;
    const directSock = new FakeSocket();
    const directDeadline = held();
    const directFrame = (frame: Record<string, unknown>, extra: Partial<Parameters<typeof handleNodeControlMessage>[0]> = {}) =>
      handleNodeControlMessage({
        db, registry: stack.runtime.realtime, presence, workspaceId: ws.workspaceId, nodeId: directNodeId,
        socket: directSock, workspaceDeadline: directDeadline, raw: JSON.stringify(frame), ...extra,
      });
    await directFrame({ v: 1, id: 'dr', type: 'node.register', node_id: directNodeId, name: `direct-${direct.agentId}`, capabilities: [], max_agents: 1, tags: [], version: 'sdk', resume_cursor: null });
    take();
    const sdkBeat = (id: string) => ({ v: 1, id, type: 'node.heartbeat', node_id: directNodeId, load: null, active_agents: 1, handlers_live: false });
    await directFrame(sdkBeat('b1'));
    const directBeat = take();
    await directFrame(sdkBeat('b2'), { heartbeatCheckpoint: { role: 'direct' } });
    const directCheckpoint = take();
    expect(directSock.ofType('reply').at(-1)).toMatchObject({ id: 'b2', data: { agent_presence: true, agent_id: direct.agentId } });

    await settleNodeOffline(db, stack.runtime.realtime, ws.workspaceId, directNodeId, { claimRevision: Number.MAX_SAFE_INTEGER });
    const offlineSettle = take();

    expect({
      register, changedBeat, unchangedBeat, brokerCheckpoint, inventorySync, directBeat, directCheckpoint, offlineSettle,
    }).toMatchInlineSnapshot(`
      {
        "brokerCheckpoint": [
          "select from "node_providers"",
          "update "node_providers"",
          "update "nodes"",
        ],
        "changedBeat": [
          "select from "nodes"",
          "select from "node_providers"",
          "update "node_providers"",
          "update "nodes"",
        ],
        "directBeat": [
          "select from "nodes"",
          "update "nodes"",
          "update "agents"",
        ],
        "directCheckpoint": [
          "update "nodes"",
          "update "agents"",
        ],
        "inventorySync": [
          "select from "workspaces"",
          "select from "nodes"",
          "select from "agents"",
          "select from "nodes"",
          "select from "action_invocations"",
          "select from "agent_node_bindings"",
          "update "agents"",
          "insert into "agent_node_bindings"",
          "update "agents"",
          "update "agent_node_bindings"",
          "select from "agents"",
        ],
        "offlineSettle": [
          "update "node_providers"",
          "update "agents"",
          "update "agents"",
          "select from "action_invocations"",
        ],
        "register": [
          "select from "workspaces"",
          "select from "nodes"",
          "select from "nodes"",
          "select from "nodes"",
          "delete from "actions"",
          "update "actions"",
          "select from "actions"",
          "insert into "actions"",
          "select from "node_providers"",
          "insert into "node_providers"",
          "update "nodes"",
          "select from "node_providers"",
          "update "nodes"",
          "select from "nodes"",
          "insert into "workspace_events"",
          "insert into "pending_events"",
          "update "pending_events"",
          "update "pending_events"",
          "select from "event_subscriptions"",
          "select from "agents"",
          "select from "pending_events"",
          "update "pending_events"",
        ],
        "unchangedBeat": [
          "select from "nodes"",
          "select from "node_providers"",
          "update "node_providers"",
          "update "nodes"",
        ],
      }
    `);
  });

  it('re-materializes actions only when the action subset changes', async () => {
    const ws = await createWorkspace(stack.app, 'materialize');
    await enrollBroker(ws.workspaceKey, 'nb');
    const { db, take } = counting();
    const sock = new FakeSocket();
    const broker = (frame: Record<string, unknown>) => handleNodeControlMessage({
      db, registry: stack.runtime.realtime, workspaceId: ws.workspaceId, nodeId: 'nb', socket: sock, raw: JSON.stringify(frame),
    });
    await broker({ v: 1, id: 'r', type: 'node.register', name: 'nb', node_id: 'nb', provider: { name: 'broker', instance_id: 'i1' }, capabilities: brokerCapabilities, max_agents: 4, tags: [], version: 'v1', resume_cursor: null });
    await broker(brokerBeat([]));
    take();
    const actionWrites = (statements: string[]) => statements.filter((s) => /^(insert into|update|delete from) "actions"/.test(s));

    await broker(brokerBeat(['worker-a', 'worker-b']));
    expect(actionWrites(take())).toEqual([]);

    await broker({ ...brokerBeat(['worker-a', 'worker-b']), capabilities: [...brokerBeat([]).capabilities, { name: 'deploy', kind: 'action' }] });
    expect(actionWrites(take())).not.toEqual([]);
    const actions = stack.runtime.handle.sqlite
      .prepare('SELECT name FROM actions WHERE workspace_id = ? AND handler_node_id = ? ORDER BY name').all(ws.workspaceId, 'nb');
    expect(actions).toEqual([{ name: 'deploy' }, { name: 'echo' }]);
  });

  it('checks a heartbeat against the held workspace deadline and reads it for every other frame', async () => {
    const ws = await createWorkspace(stack.app, 'deadline');
    await enrollBroker(ws.workspaceKey, 'nb');
    const { db, take } = counting();
    const sock = new FakeSocket();
    const deadline = held();
    const send = (frame: Record<string, unknown>) => handleNodeControlMessage({
      db, registry: stack.runtime.realtime, workspaceId: ws.workspaceId, nodeId: 'nb', socket: sock,
      workspaceDeadline: deadline, raw: JSON.stringify(frame),
    });
    const workspaceReads = (statements: string[]) => statements.filter((s) => s === 'select from "workspaces"').length;

    await send({ v: 1, id: 'r', type: 'node.register', name: 'nb', node_id: 'nb', provider: { name: 'broker', instance_id: 'i1' }, capabilities: brokerCapabilities, max_agents: 4, tags: [], version: 'v1', resume_cursor: null });
    expect(workspaceReads(take())).toBe(1);
    expect(deadline.value).toEqual({ expiresAt: null });
    await send(brokerBeat([]));
    expect(workspaceReads(take())).toBe(0);

    // A held deadline that has passed refuses the heartbeat without a read.
    deadline.value = { expiresAt: new Date(Date.now() - 1_000) };
    sock.received.length = 0;
    await send(brokerBeat([]));
    expect(workspaceReads(take())).toBe(0);
    expect(sock.ofType('error').at(-1)).toMatchObject({ code: 'workspace_expired' });

    // Identity-creating frames re-read the row and refresh the held copy.
    await send({ v: 1, id: 'r2', type: 'node.register', name: 'nb', node_id: 'nb', provider: { name: 'broker', instance_id: 'i1' }, capabilities: brokerCapabilities, max_agents: 4, tags: [], version: 'v1', resume_cursor: null });
    expect(workspaceReads(take())).toBe(1);
    expect(deadline.value).toEqual({ expiresAt: null });
  });

  it('settles an offline node and fans presence out through node-scoped indexes', async () => {
    const ws = await createWorkspace(stack.app, 'plans');
    const { db, raw } = counting();
    for (const name of ['a', 'b', 'c']) await registerAgent(stack.app, ws.workspaceKey, name);
    raw.length = 0;
    await settleNodeOffline(db, stack.runtime.realtime, ws.workspaceId, 'node_direct_x', { claimRevision: 1 });
    await settleNodeOffline(db, stack.runtime.realtime, ws.workspaceId, 'node_direct_x');
    const routeLoss = raw.filter((statement) => statement.sql.startsWith('update "agents" set "status"'));
    expect(routeLoss).toHaveLength(2);
    for (const statement of routeLoss) {
      expect(plan(statement)).toContain('idx_agents_location_node_liveness_revision (workspace_id=? AND location_node_id=?');
    }

    raw.length = 0;
    await sendNodePresenceContext({ db, workspaceId: ws.workspaceId, nodeConnections: stack.runtime.realtime }, {
      subjectAgentId: 'a', event: 'agent.status.offline', data: {},
    });
    const [fanout] = raw;
    const fanoutPlan = plan(fanout);
    expect(fanoutPlan.indexOf('idx_nodes_context_reachable')).toBeGreaterThan(-1);
    expect(fanoutPlan.indexOf('idx_nodes_context_reachable')).toBeLessThan(fanoutPlan.indexOf('agent_node_bindings'));
    expect(fanoutPlan).not.toContain('idx_agent_node_bindings_workspace');
  });

  it('tells the direct node to stop acknowledging an agent whose binding moved or ended', async () => {
    const ws = await createWorkspace(stack.app, 'invalidate');
    await enrollBroker(ws.workspaceKey, 'nb');
    const db = stack.runtime.deps.db;
    const invalidated: string[] = [];
    configureNodeLiveness(db, {
      inspect: async () => ({ status: 'unknown', providers: [] }),
      invalidate: async (_workspaceId, nodeId) => { invalidated.push(nodeId); },
    });
    const moved = await registerAgent(stack.app, ws.workspaceKey, 'moved');
    const released = await registerAgent(stack.app, ws.workspaceKey, 'released');

    await bindAgentToNode(db, ws.workspaceId, 'nb', 'moved');
    expect(invalidated.splice(0)).toEqual([`node_direct_${moved.agentId}`]);
    await unbindAgentFromNode(db, ws.workspaceId, 'nb', 'moved');
    expect(invalidated.splice(0)).toEqual([`node_direct_${moved.agentId}`]);
    await bindAgentToNode(db, ws.workspaceId, 'nb', 'moved');
    invalidated.length = 0;
    await deregisterAgentViaNode(db, ws.workspaceId, 'nb', { agent_id: moved.agentId });
    expect(invalidated.splice(0)).toEqual([`node_direct_${moved.agentId}`]);
    await deleteAgent(db, ws.workspaceId, 'released');
    expect(invalidated.splice(0)).toEqual([`node_direct_${released.agentId}`]);
  });

  it('invalidates an agent an inventory moved even when a later member fails', async () => {
    const ws = await createWorkspace(stack.app, 'invalidate-partial');
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'tight', name: 'tight', role: 'broker', capabilities: [], max_agents: 1, tags: [], version: 'v0' }),
    });
    expect(created.status).toBe(201);
    const db = stack.runtime.deps.db;
    const invalidated: string[] = [];
    configureNodeLiveness(db, {
      inspect: async () => ({ status: 'unknown', providers: [] }),
      invalidate: async (_workspaceId, nodeId) => { invalidated.push(nodeId); },
    });
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const sock = new FakeSocket();
    const frame = (body: Record<string, unknown>) => handleNodeControlMessage({
      db, registry: stack.runtime.realtime, completionDeps: stack.runtime.deps,
      workspaceId: ws.workspaceId, nodeId: 'tight', socket: sock, raw: JSON.stringify(body),
    });
    const provider = { name: 'broker', instance_id: 'i1' };
    await frame({ v: 1, id: 'r', type: 'node.register', name: 'tight', node_id: 'tight', provider, capabilities: [], max_agents: 1, tags: [], version: 'v1', resume_cursor: null });
    await frame({ v: 1, type: 'node.heartbeat', provider, name: 'tight', node_id: 'tight', capabilities: [], max_agents: 1, version: 'v1', load: 0, active_agents: 0, handlers_live: true });
    invalidated.length = 0;

    // One free slot: alice's move commits, bob's slot reservation fails.
    await frame({ v: 1, id: 'inv', type: 'inventory.sync', agents: [
      { agent_id: alice.agentId, name: 'alice', session_ref: 'pty://a' },
      { agent_id: bob.agentId, name: 'bob', session_ref: 'pty://b' },
    ] });
    expect(sock.ofType('error').at(-1)).toMatchObject({ id: 'inv', code: 'node_capacity_exceeded' });
    const location = await stack.runtime.handle.sqlite
      .prepare('SELECT location_node_id FROM agents WHERE id = ?').get(alice.agentId) as { location_node_id: string | null };
    expect(location.location_node_id).toBe('tight');
    expect(invalidated).toEqual([`node_direct_${alice.agentId}`]);
  });
});
