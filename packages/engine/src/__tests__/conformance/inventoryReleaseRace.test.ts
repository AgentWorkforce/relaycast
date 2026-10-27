import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { FLEET_DELIVERY_CURSOR_CAPABILITY } from '@relaycast/types';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';
import { actionInvocations, agentNodeBindings, agents } from '../../db/schema.js';
import { ACTION_DISPATCH_TIMEOUT_MS } from '../../engine/action.js';

type Workspace = Awaited<ReturnType<typeof createWorkspace>>;

interface AttachedNode {
  id: string;
  sock: FakeSocket;
  handle: { handleMessage(raw: string): Promise<void>; handleClose(): Promise<void> };
}

/**
 * A node ends a released agent and stops listing it before its release result
 * reaches Relaycast: Agent Relay Desktop sends its inventory as soon as the
 * agent's place is given back. Observed on 2026-10-17 for two spawns
 * (`inv_idem_5cc21f86…`, `inv_idem_c5381090…`): the missing sweep deactivated
 * each binding first, so the completion failed with `agent_identity_mismatch`
 * and Cloud reported the release unconfirmed although both agents had ended.
 */
describe('inventory sync during an exact release', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function attachNode(ws: Workspace, id: string): Promise<AttachedNode> {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: id,
        name: id,
        capabilities: ['spawn:codex', FLEET_DELIVERY_CURSOR_CAPABILITY],
        max_agents: 4,
        version: 'inventory-release-race-test',
      }),
    });
    expect(enrolled.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `register-${id}`,
      type: 'node.register',
      name: id,
      node_id: id,
      provider: { name: 'broker', instance_id: `${id}-broker` },
      capabilities: [
        { name: 'spawn:codex', kind: 'capacity' },
        { name: FLEET_DELIVERY_CURSOR_CAPABILITY, kind: 'capacity' },
      ],
      max_agents: 4,
      tags: ['inventory-release-race-test'],
      version: 'inventory-release-race-test',
      resume_cursor: null,
    }));
    expect(sock.ofType('reply').find((frame) => frame.id === `register-${id}`)).toMatchObject({ ok: true });
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `heartbeat-${id}`,
      type: 'node.heartbeat',
      provider: { name: 'broker', instance_id: `${id}-broker` },
      load: 0,
      active_agents: 0,
      handlers_live: true,
    }));
    return { id, sock, handle };
  }

  async function registerViaNode(node: AttachedNode, name: string): Promise<string> {
    const requestId = `register-${node.id}-${name}`;
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      id: requestId,
      type: 'agent.register',
      name,
      resumable: true,
      session_ref: `session-${name}`,
    }));
    const reply = node.sock.ofType('reply').find((frame) => frame.id === requestId) as {
      ok: boolean;
      data: { agent_id: string };
    } | undefined;
    expect(reply).toMatchObject({ ok: true });
    return reply!.data.agent_id;
  }

  /** Cloud's release: `release-exact` with the immutable id and a stable key. */
  async function releaseExact(ws: Workspace, name: string, expectedAgentId: string, key: string) {
    const res = await stack.app.request('/v1/agents/release-exact', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
        'idempotency-key': key,
      },
      body: JSON.stringify({ name, expected_agent_id: expectedAgentId, delete_agent: true }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { status: string; invocation_id: string } };
    expect(data.status).toBe('dispatched');
    return data.invocation_id;
  }

  async function syncInventory(node: AttachedNode, requestId: string, names: Array<[string, string]>) {
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      id: requestId,
      type: 'inventory.sync',
      agents: names.map(([agentId, name]) => ({ agent_id: agentId, name, session_ref: `session-${name}` })),
    }));
  }

  async function answerReleased(node: AttachedNode, invocationId: string, name: string) {
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: invocationId,
      output: { released: true, name },
    }));
  }

  async function invocation(id: string) {
    const [row] = await stack.runtime.deps.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, id));
    return row;
  }

  async function agentRow(agentId: string) {
    const [row] = await stack.runtime.deps.db
      .select({ name: agents.name, status: agents.status, metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row;
  }

  async function binding(workspaceId: string, agentId: string, nodeId: string) {
    const [row] = await stack.runtime.deps.db
      .select({ status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, workspaceId),
        eq(agentNodeBindings.agentId, agentId),
        eq(agentNodeBindings.nodeId, nodeId),
      ));
    return row?.status;
  }

  // MUST-FIRE: before the fix the empty inventory deactivated the binding and
  // the result failed with agent_identity_mismatch.
  it('completes the release when the inventory without the agent arrives first', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-release-race');
    const node = await attachNode(ws, 'node_release_race');
    const agentId = await registerViaNode(node, 'released-worker');
    const keeperId = await registerViaNode(node, 'kept-worker');
    const invocationId = await releaseExact(ws, 'released-worker', agentId, 'hosted-release:race-1');

    await syncInventory(node, 'inventory-before-result', [[keeperId, 'kept-worker']]);
    expect(await binding(ws.workspaceId, agentId, node.id)).toBe('active');
    expect(await invocation(invocationId)).toMatchObject({ status: 'dispatched' });

    await answerReleased(node, invocationId, 'released-worker');
    expect(await invocation(invocationId)).toMatchObject({ status: 'completed', error: null });
    expect(await agentRow(agentId)).toMatchObject({
      name: `released-worker#released-${agentId}`,
      status: 'released',
      metadata: {
        release: { previous_name: 'released-worker', released_at: expect.any(String) },
      },
    });
    expect(await binding(ws.workspaceId, agentId, node.id)).toBe('inactive');
    // The agent the node still lists is untouched.
    expect(await binding(ws.workspaceId, keeperId, node.id)).toBe('active');
  });

  // MUST-NOT-FIRE: a release nobody answers stops shielding its agent once
  // the dispatch timeout has passed, so a lost agent is still swept offline.
  it('sweeps the agent as missing once its release is older than the dispatch timeout', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-release-stuck');
    const node = await attachNode(ws, 'node_release_stuck');
    const agentId = await registerViaNode(node, 'stuck-worker');
    const invocationId = await releaseExact(ws, 'stuck-worker', agentId, 'hosted-release:stuck-1');
    const stale = new Date(Date.now() - ACTION_DISPATCH_TIMEOUT_MS - 1_000);
    await stack.runtime.deps.db
      .update(actionInvocations)
      .set({ dispatchedAt: stale, createdAt: stale })
      .where(eq(actionInvocations.id, invocationId));

    await syncInventory(node, 'inventory-after-timeout', []);
    expect(await binding(ws.workspaceId, agentId, node.id)).toBe('inactive');
    expect(await agentRow(agentId)).toMatchObject({ name: 'stuck-worker', status: 'offline' });
  });

  // MUST-NOT-FIRE: a release of a different immutable identity under the same
  // name does not shield the agent the node no longer lists.
  it('does not shield an agent whose id the release does not name', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-release-other-id');
    const node = await attachNode(ws, 'node_release_other_id');
    const agentId = await registerViaNode(node, 'renamed-worker');
    const invocationId = await releaseExact(ws, 'renamed-worker', agentId, 'hosted-release:other-1');
    await stack.runtime.deps.db
      .update(actionInvocations)
      .set({ input: { name: 'renamed-worker', expected_agent_id: 'not-this-agent', delete_agent: true } })
      .where(eq(actionInvocations.id, invocationId));

    await syncInventory(node, 'inventory-other-id', []);
    expect(await binding(ws.workspaceId, agentId, node.id)).toBe('inactive');
    expect(await agentRow(agentId)).toMatchObject({ status: 'offline' });
  });
});
