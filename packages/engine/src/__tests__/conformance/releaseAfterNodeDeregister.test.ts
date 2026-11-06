import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  attachDirectNodeSocket,
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { actionInvocations, agentNodeBindings, agents, nodes, workspaceEvents } from '../../db/schema.js';

type Json = Record<string, unknown>;

/**
 * A relay broker finishes a release by queueing `agent.deregister` and then
 * `action.result` on one control channel. The deregister must leave the
 * binding for release completion. A result is still refused once any other
 * node, including a live `node_direct_<id>`, is the active binding.
 */
describe('node release completed after the node deregistered the agent', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => {
    await stack.close();
  });

  const db = () => stack.runtime.deps.db;

  async function enrollBroker(ws: { workspaceKey: string; workspaceId: string }, nodeId: string, name: string) {
    const enroll = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, capabilities: ['spawn:claude'], max_agents: 4, version: 'test-node' }),
    });
    expect(enroll.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }, { name: 'release', kind: 'capacity' }],
      max_agents: 4, tags: [], version: 'test-node', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  async function registerOnNode(node: Awaited<ReturnType<typeof enrollBroker>>, name: string) {
    await node.handle.handleMessage(JSON.stringify({
      v: 1, type: 'agent.register', name, resumable: true, session_ref: `sess-${name}`,
    }));
    const reply = node.sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string } };
    expect(reply?.ok).toBe(true);
    return reply.data.agent_id;
  }

  async function releaseDispatched(workspaceKey: string, name: string) {
    const res = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { status: string; invocation_id: string } };
    expect(data.status).toBe('dispatched');
    return data.invocation_id;
  }

  async function invocation(id: string) {
    const [row] = await db()
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, id));
    return row;
  }

  async function agentLocation(agentId: string) {
    const [row] = await db()
      .select({
        status: agents.status,
        locationType: agents.locationType,
        locationNodeId: agents.locationNodeId,
      })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row;
  }

  async function bindings(workspaceId: string, agentId: string) {
    const rows = await db()
      .select({ nodeId: agentNodeBindings.nodeId, status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.agentId, agentId),
      ));
    return rows.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  async function slot(workspaceId: string, nodeId: string) {
    const [row] = await db()
      .select({ activeAgents: nodes.activeAgents, status: nodes.status })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
    return row;
  }

  async function exits(workspaceId: string) {
    const rows = await db()
      .select({ payload: workspaceEvents.payload })
      .from(workspaceEvents)
      .where(and(
        eq(workspaceEvents.workspaceId, workspaceId),
        eq(workspaceEvents.type, 'agent.exited'),
      ));
    return rows.map((row) => JSON.parse(row.payload) as Json);
  }

  it('completes a plain release whose node deregistered the agent before reporting the result', async () => {
    const ws = await createWorkspace(stack.app, 'release-after-deregister');
    const node = await enrollBroker(ws, 'node_a', 'node-a');
    const agentId = await registerOnNode(node, 'worker');
    const invocationId = await releaseDispatched(ws.workspaceKey, 'worker');
    expect(node.sock.ofType('action.invoke').map((frame) => (frame as Json).action)).toContain('release');
    expect(await slot(ws.workspaceId, 'node_a')).toMatchObject({ activeAgents: 1 });

    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', agent_id: agentId, name: 'worker' }));

    // The open release still owns the binding. Deregister does not re-home
    // onto the implicit direct node or emit an exit.
    expect(await invocation(invocationId)).toEqual({ status: 'dispatched', error: null });
    expect(await agentLocation(agentId)).toEqual({
      status: 'active', locationType: 'via_node', locationNodeId: 'node_a',
    });
    expect(await bindings(ws.workspaceId, agentId)).toEqual([{ nodeId: 'node_a', status: 'active' }]);
    expect(await slot(ws.workspaceId, 'node_a')).toMatchObject({ activeAgents: 1 });
    expect(await slot(ws.workspaceId, `node_direct_${agentId}`)).toBeUndefined();
    expect(await exits(ws.workspaceId)).toEqual([]);

    await node.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { released: true },
    }));

    expect(await invocation(invocationId)).toEqual({ status: 'completed', error: null });
    expect(await agentLocation(agentId)).toEqual({
      status: 'offline', locationType: 'self_connected', locationNodeId: null,
    });
    expect(await bindings(ws.workspaceId, agentId)).toEqual([{ nodeId: 'node_a', status: 'inactive' }]);
    expect(await slot(ws.workspaceId, 'node_a')).toMatchObject({ activeAgents: 0 });
    expect(await slot(ws.workspaceId, `node_direct_${agentId}`)).toBeUndefined();
    expect(await exits(ws.workspaceId)).toEqual([
      expect.objectContaining({
        type: 'agent.exited',
        agent_id: agentId,
        agent_name: 'worker',
        node_id: 'node_a',
        reason: 'released',
      }),
    ]);
  });

  it('does not complete the late broker result after the agent reconnects on its live direct node', async () => {
    const ws = await createWorkspace(stack.app, 'release-after-reconnect');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const direct = await attachDirectNodeSocket(stack, ws.workspaceId, agent);
    const broker = await enrollBroker(ws, 'node_a', 'node-a');
    const bound = await stack.app.request('/v1/nodes/node-a/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ agent_name: 'worker' }),
    });
    expect(bound.status).toBe(201);

    const invocationId = await releaseDispatched(ws.workspaceKey, 'worker');
    await broker.handle.handleMessage(JSON.stringify({
      v: 1, type: 'agent.deregister', agent_id: agent.agentId, name: 'worker',
    }));
    expect(await agentLocation(agent.agentId)).toMatchObject({ locationNodeId: 'node_a' });
    expect(await bindings(ws.workspaceId, agent.agentId)).toEqual([
      { nodeId: 'node_a', status: 'active' },
      { nodeId: direct.nodeId, status: 'inactive' },
    ]);

    // The agent reconnects on its own live direct node, which becomes the
    // active binding, before the broker reports the release.
    await direct.handle.handleMessage(JSON.stringify({
      v: 1, id: 'reconnect', type: 'agent.recover', name: 'worker', expected_agent_id: agent.agentId,
    }));
    expect(direct.sock.ofType('reply').find((frame) => frame.id === 'reconnect')).toMatchObject({ ok: true });
    expect(await slot(ws.workspaceId, direct.nodeId)).toMatchObject({ status: 'online', activeAgents: 1 });
    expect(await agentLocation(agent.agentId)).toEqual({
      status: 'active', locationType: 'via_node', locationNodeId: direct.nodeId,
    });
    expect(await bindings(ws.workspaceId, agent.agentId)).toEqual([
      { nodeId: 'node_a', status: 'inactive' },
      { nodeId: direct.nodeId, status: 'active' },
    ]);
    expect(await slot(ws.workspaceId, 'node_a')).toMatchObject({ activeAgents: 0 });

    await broker.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { released: true },
    }));

    expect(await invocation(invocationId)).toEqual({ status: 'failed', error: 'agent_release_generation_conflict' });
    expect(await agentLocation(agent.agentId)).toEqual({
      status: 'active', locationType: 'via_node', locationNodeId: direct.nodeId,
    });
    expect(await bindings(ws.workspaceId, agent.agentId)).toEqual([
      { nodeId: 'node_a', status: 'inactive' },
      { nodeId: direct.nodeId, status: 'active' },
    ]);
    expect(await slot(ws.workspaceId, direct.nodeId)).toMatchObject({ status: 'online', activeAgents: 1 });
    expect(await slot(ws.workspaceId, 'node_a')).toMatchObject({ activeAgents: 0 });
    expect(await exits(ws.workspaceId)).toEqual([]);
  });
});
