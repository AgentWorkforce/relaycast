import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { actionInvocations, agentNodeBindings, agents, nodes } from '../../db/schema.js';
import { AGENT_LIVENESS_TTL_MS } from '../../engine/agent.js';
import {
  attachDirectNodeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

describe('agent presence and release lifecycle', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('derives presence from last_seen and persists stale active agents offline', async () => {
    const ws = await createWorkspace(stack.app, 'agent-presence-expiry');
    const stale = await registerAgent(stack.app, ws.workspaceKey, 'stale-agent');
    await stack.runtime.deps.db
      .update(agents)
      .set({
        status: 'active',
        lastSeen: new Date(Date.now() - AGENT_LIVENESS_TTL_MS - 1_000),
      })
      .where(eq(agents.id, stale.agentId));

    const response = await stack.app.request('/v1/agents?status=active', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ name: string }> };
    expect(body.data.map((agent) => agent.name)).not.toContain('stale-agent');

    const [persisted] = await stack.runtime.deps.db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, stale.agentId));
    expect(persisted.status).toBe('offline');
  });

  it('fails release explicitly when the agent has no live host', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-release');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'hostless-agent');
    const nodeId = `node_direct_${target.agentId}`;

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, reason: 'stale cleanup' }),
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'agent_host_unavailable',
      message: 'Agent "hostless-agent" has no live host node; cannot dispatch release',
    });

    const [agent] = await stack.runtime.deps.db
      .select({ status: agents.status, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, target.agentId));
    expect(agent).toMatchObject({ status: 'active', locationNodeId: nodeId });

    const [binding] = await stack.runtime.deps.db
      .select({ status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, target.agentId),
        eq(agentNodeBindings.nodeId, nodeId),
      ));
    expect(binding.status).toBe('active');

    const [invocation] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'release'),
      ));
    expect(invocation).toMatchObject({
      status: 'failed',
      error: 'agent_host_unavailable',
    });
  });

  it('deletes a hostless agent and its implicit direct node', async () => {
    const ws = await createWorkspace(stack.app, 'hostless-agent-delete');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'delete-me');
    const nodeId = `node_direct_${target.agentId}`;
    // Reproduce a legacy/orphaned roster row with no dispatchable location.
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, target.agentId));

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name, delete_agent: true }),
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { data: { status: string } }).data.status).toBe('completed');

    expect(await stack.runtime.deps.db.select().from(agents).where(eq(agents.id, target.agentId))).toHaveLength(0);
    expect(await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, nodeId))).toHaveLength(0);
  });

  it('continues dispatching release to a live host', async () => {
    const ws = await createWorkspace(stack.app, 'live-agent-release');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'live-agent');
    const { sock, handle, nodeId } = await attachDirectNodeSocket(stack, ws.workspaceId, target);

    const response = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: target.name }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as {
      data: { status: string; dispatched_node_id: string | null };
    };
    expect(body.data).toMatchObject({ status: 'dispatched', dispatched_node_id: nodeId });
    expect(sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'release' });
    await handle.handleClose();
  });
});
