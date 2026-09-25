import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, FakeSocket, type TestStack } from './harness.js';
import { actionInvocations, agentNodeBindings, agents } from '../../db/schema.js';

type Json = Record<string, unknown>;

/**
 * A relay broker completes a release by stopping the worker, queueing
 * `agent.deregister` and then sending `action.result`, in that order on its
 * one control channel. The deregister deactivates the agent's binding on the
 * node before the result arrives, so the completion must accept a binding the
 * same release already removed, while still refusing an agent that has since
 * been bound to a different node.
 */
describe('node release completed after the node deregistered the agent', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => {
    await stack.close();
  });

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
    const [row] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, id));
    return row;
  }

  it('completes a plain release whose node deregistered the agent before reporting the result', async () => {
    const ws = await createWorkspace(stack.app, 'release-after-deregister');
    const node = await enrollBroker(ws, 'node_a', 'node-a');
    const agentId = await registerOnNode(node, 'worker');

    const invocationId = await releaseDispatched(ws.workspaceKey, 'worker');
    expect(node.sock.ofType('action.invoke').map((frame) => (frame as Json).action)).toContain('release');

    // The broker's order: deregister first, then the release result.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', agent_id: agentId, name: 'worker' }));
    await node.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { released: true },
    }));

    expect(await invocation(invocationId)).toEqual({ status: 'completed', error: null });
    const [agent] = await stack.runtime.deps.db
      .select({ status: agents.status, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent).toEqual({ status: 'offline', locationNodeId: null });
  });

  it('still refuses the release once the agent is bound to a different node', async () => {
    const ws = await createWorkspace(stack.app, 'release-after-move');
    const nodeA = await enrollBroker(ws, 'node_a', 'node-a');
    const agentId = await registerOnNode(nodeA, 'worker');

    const invocationId = await releaseDispatched(ws.workspaceKey, 'worker');
    await nodeA.handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.deregister', agent_id: agentId, name: 'worker' }));
    // Before node A reports, the identity is bound to node B: the state a
    // concurrent move leaves behind, written directly.
    await enrollBroker(ws, 'node_b', 'node-b');
    const db = stack.runtime.deps.db;
    await db.insert(agentNodeBindings).values({
      id: 'bind_moved_to_b', workspaceId: ws.workspaceId, agentId, nodeId: 'node_b', status: 'active', priority: 0,
    }).onConflictDoUpdate({
      target: [agentNodeBindings.agentId, agentNodeBindings.nodeId],
      set: { status: 'active' },
    });
    await db.update(agents).set({ locationType: 'via_node', locationNodeId: 'node_b', status: 'active' }).where(eq(agents.id, agentId));

    await nodeA.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { released: true },
    }));

    expect(await invocation(invocationId)).toEqual({ status: 'failed', error: 'agent_release_generation_conflict' });
    const [agent] = await stack.runtime.deps.db
      .select({ status: agents.status, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent.locationNodeId).toBe('node_b');
    expect(agent.status).not.toBe('offline');
  });
});
