import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  FakeSocket,
  type TestStack,
} from './harness.js';
import { actionInvocations, nodes, workspaceEvents } from '../../db/schema.js';
import { sweepOfflineNodes } from '../../engine/node.js';
import { NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';

/**
 * Durable observability for agent exit + node liveness (issue #273): every
 * exit / node transition lands in the durable workspace event log AND the
 * webhook outbox, so it is push-visible instead of poll-only.
 *
 * These assert the durable `workspace_events` log (never drained). The webhook
 * outbox (`pending_events`) is proven by the helper unit tests instead — the
 * Node adapter's queue polls and deletes subscriber-less outbox rows right after
 * `send`, so a row-count assertion here would be racy.
 */
describe('agent.exited + node.status durable events', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function enrollNode(workspaceKey: string, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  function attach(workspaceId: string, nodeId: string) {
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
    return { sock, handle };
  }

  async function bringNodeOnline(ws: { workspaceKey: string; workspaceId: string }, nodeId: string, name: string) {
    await enrollNode(ws.workspaceKey, nodeId, name);
    const { sock, handle } = attach(ws.workspaceId, nodeId);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  async function registerAgentViaNode(handle: { handleMessage(raw: string): Promise<void> }, sock: FakeSocket, name: string) {
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.register', name, resumable: true }));
    const reply = sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string; name?: string } };
    expect(reply?.ok).toBe(true);
    return reply.data.agent_id;
  }

  const db = () => stack.runtime.deps.db;

  async function workspaceEventsOfType(workspaceId: string, type: string) {
    return db().select().from(workspaceEvents)
      .where(and(eq(workspaceEvents.workspaceId, workspaceId), eq(workspaceEvents.type, type)));
  }

  it('(a) agent.deregister control frame emits a durable agent.exited', async () => {
    const ws = await createWorkspace(stack.app, 'exit-a');
    const { sock, handle } = await bringNodeOnline(ws, 'node_a', 'alpha');
    const agentId = await registerAgentViaNode(handle, sock, 'worker-a');

    await handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', agent_id: agentId }));

    const logged = await workspaceEventsOfType(ws.workspaceId, 'agent.exited');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload)).toMatchObject({
      type: 'agent.exited', agent_id: agentId, agent_name: 'worker-a', node_id: 'node_a', reason: 'deregistered',
    });
  });

  it('(b) inventory.sync with a missing agent emits agent.exited', async () => {
    const ws = await createWorkspace(stack.app, 'exit-b');
    const { sock, handle } = await bringNodeOnline(ws, 'node_b', 'beta');
    const keepId = await registerAgentViaNode(handle, sock, 'keep');
    const dropId = await registerAgentViaNode(handle, sock, 'drop');

    // Inventory lists only "keep"; "drop" is missing and must be flipped + emitted.
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'inventory.sync', agents: [{ agent_id: keepId, name: 'keep' }],
    }));

    const logged = await workspaceEventsOfType(ws.workspaceId, 'agent.exited');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload)).toMatchObject({
      agent_id: dropId, agent_name: 'drop', node_id: 'node_b', reason: 'missing_from_inventory',
    });
  });

  it('(c) release completion emits agent.exited', async () => {
    const ws = await createWorkspace(stack.app, 'exit-c');
    const { sock, handle } = await bringNodeOnline(ws, 'node_c', 'gamma');
    const agentId = await registerAgentViaNode(handle, sock, 'releasee');

    await db().insert(actionInvocations).values({
      id: 'inv_release_c',
      workspaceId: ws.workspaceId,
      actionName: 'release',
      input: { name: 'releasee' },
      status: 'dispatched',
      dispatchedNodeId: 'node_c',
      dispatchedProvider: 'default',
      dispatchedAt: new Date(),
    });

    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: 'inv_release_c', output: {},
    }));

    const logged = await workspaceEventsOfType(ws.workspaceId, 'agent.exited');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload)).toMatchObject({
      agent_id: agentId, agent_name: 'releasee', node_id: 'node_c', reason: 'released',
    });
  });

  it('(d) node liveness sweep emits node.status.offline', async () => {
    const ws = await createWorkspace(stack.app, 'exit-d');
    await bringNodeOnline(ws, 'node_d', 'delta');

    // Age the heartbeat past the liveness TTL so the sweep flips it offline.
    await db().update(nodes)
      .set({ lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 5_000) })
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_d')));

    const swept = await sweepOfflineNodes(db(), stack.runtime.realtime, stack.runtime.deps);
    expect(swept).toBeGreaterThanOrEqual(1);

    const logged = await workspaceEventsOfType(ws.workspaceId, 'node.status.offline');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload)).toMatchObject({
      type: 'node.status.offline', node_id: 'node_d', node_name: 'delta', reason: 'liveness_timeout',
    });
  });

  it('(f) repeated agent.deregister frames emit agent.exited exactly once', async () => {
    const ws = await createWorkspace(stack.app, 'exit-f');
    const { sock, handle } = await bringNodeOnline(ws, 'node_f', 'zeta');
    const agentId = await registerAgentViaNode(handle, sock, 'worker-f');

    // First deregister transitions the agent and re-homes its location to the
    // implicit direct node, so subsequent frames for node_f no longer match.
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', agent_id: agentId }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', agent_id: agentId }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', name: 'worker-f' }));

    expect(await workspaceEventsOfType(ws.workspaceId, 'agent.exited')).toHaveLength(1);
  });

  it('(g) deregistering the last online provider emits node.status.offline even with a leftover offline provider row', async () => {
    const ws = await createWorkspace(stack.app, 'exit-g');
    await enrollNode(ws.workspaceKey, 'node_g', 'eta');

    // Two providers on the node: py + rb.
    const py = attach(ws.workspaceId, 'node_g');
    await py.handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg-py', type: 'node.register', name: 'eta', node_id: 'node_g',
      provider: { name: 'py', instance_id: 'py-i1' },
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }], max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await py.handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', provider: { name: 'py', instance_id: 'py-i1' }, load: 0, active_agents: 0, handlers_live: true }));
    const rb = attach(ws.workspaceId, 'node_g');
    await rb.handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg-rb', type: 'node.register', name: 'eta', node_id: 'node_g',
      provider: { name: 'rb', instance_id: 'rb-i1' },
      capabilities: [{ name: 'build', kind: 'action' }], max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await rb.handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', provider: { name: 'rb', instance_id: 'rb-i1' }, load: 0, active_agents: 0, handlers_live: true }));

    // rb's socket drops while py remains: rb becomes a persisted *offline* provider
    // row and the node stays online, so nothing is emitted yet.
    await rb.handle.handleClose();
    expect(await workspaceEventsOfType(ws.workspaceId, 'node.status.offline')).toHaveLength(0);

    // Deregister py (the last online provider). The leftover rb row keeps
    // remaining.count > 0, routing through recomputeNodeAggregate — which flips the
    // node offline. The durable node.status.offline must still be emitted.
    await py.handle.handleMessage(JSON.stringify({ v: 1, type: 'node.deregister', provider: { name: 'py', instance_id: 'py-i1' } }));

    const logged = await workspaceEventsOfType(ws.workspaceId, 'node.status.offline');
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(logged.some((row) => {
      const p = JSON.parse(row.payload) as { node_id?: string; reason?: string };
      return p.node_id === 'node_g' && p.reason === 'deregistered';
    })).toBe(true);
  });

  it('(e) re-heartbeat after offline emits node.status.online exactly once', async () => {
    const ws = await createWorkspace(stack.app, 'exit-e');
    // Initial register already produces the first offline->online transition.
    await bringNodeOnline(ws, 'node_e', 'epsilon');
    expect(await workspaceEventsOfType(ws.workspaceId, 'node.status.online')).toHaveLength(1);

    // Force offline via the sweep.
    await db().update(nodes)
      .set({ lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 5_000) })
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_e')));
    await sweepOfflineNodes(db(), stack.runtime.realtime, stack.runtime.deps);

    // Reconnect: a fresh register + two heartbeats. Exactly one online transition.
    const { handle } = attach(ws.workspaceId, 'node_e');
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name: 'epsilon', node_id: 'node_e',
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true }));

    // One from initial register + one from the reconnect = two total, not more.
    expect(await workspaceEventsOfType(ws.workspaceId, 'node.status.online')).toHaveLength(2);
  });
});
