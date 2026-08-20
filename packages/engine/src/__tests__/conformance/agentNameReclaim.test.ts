import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';
import { agents } from '../../db/schema.js';

/**
 * Registration is create-only. Recovery is a distinct, proof-carrying action:
 * an authenticated node must match both the server-owned origin and immutable
 * agent id. Liveness, status, and possession of a colliding name are not proof.
 */
describe('agent identity recovery across nodes', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  const db = () => stack.runtime.deps.db;

  async function bringNodeOnline(
    ws: { workspaceKey: string; workspaceId: string },
    nodeId: string,
    name: string,
  ) {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId, name, role: 'broker',
        capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'v0',
      }),
    });
    if (enrolled.status !== 201) {
      throw new Error(`node enrollment failed: ${enrolled.status} ${await enrolled.text()}`);
    }
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: `node-${nodeId}`, type: 'node.register', name, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, id: `heartbeat-${nodeId}`, type: 'node.heartbeat',
      load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  async function send(
    node: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } },
    message: Record<string, unknown>,
  ) {
    const id = String(message.id);
    await node.handle.handleMessage(JSON.stringify({ v: 1, ...message }));
    return node.sock.received.findLast((frame) => frame.id === id);
  }

  async function agentRow(workspaceId: string, name: string) {
    const [row] = await db()
      .select({
        id: agents.id,
        tokenHash: agents.tokenHash,
        previousTokenHash: agents.previousTokenHash,
        locationNodeId: agents.locationNodeId,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));
    return row;
  }

  it('refuses a colliding register from every node without mutating the identity', async () => {
    const ws = await createWorkspace(stack.app, 'register-create-only');
    const alpha = await bringNodeOnline(ws, 'node_alpha', 'alpha');
    const beta = await bringNodeOnline(ws, 'node_beta', 'beta');

    const created = await send(alpha, { id: 'create', type: 'agent.register', name: 'contested' });
    expect(created).toMatchObject({ type: 'reply', ok: true });
    const before = await agentRow(ws.workspaceId, 'contested');

    await db().update(agents).set({
      status: 'offline',
      lastSeen: new Date('2000-01-01T00:00:00.000Z'),
    }).where(eq(agents.id, before.id));

    for (const [id, node] of [['same-origin', alpha], ['foreign-origin', beta]] as const) {
      const collision = await send(node, { id, type: 'agent.register', name: 'contested' });
      expect(collision).toMatchObject({ type: 'error', ok: false, code: 'agent_already_exists' });
    }

    const after = await agentRow(ws.workspaceId, 'contested');
    expect(after).toEqual({ ...before, status: 'offline' });
  });

  it('lets only the origin node recover the exact immutable identity', async () => {
    const ws = await createWorkspace(stack.app, 'recover-origin-proof');
    const alpha = await bringNodeOnline(ws, 'node_alpha', 'alpha');
    const beta = await bringNodeOnline(ws, 'node_beta', 'beta');

    await send(alpha, { id: 'create', type: 'agent.register', name: 'restarted' });
    const before = await agentRow(ws.workspaceId, 'restarted');

    const foreign = await send(beta, {
      id: 'foreign', type: 'agent.recover', name: 'restarted', expected_agent_id: before.id,
    });
    expect(foreign).toMatchObject({ type: 'error', ok: false, code: 'agent_recovery_not_authorized' });

    const stale = await send(alpha, {
      id: 'stale', type: 'agent.recover', name: 'restarted', expected_agent_id: 'agent_stale',
    });
    expect(stale).toMatchObject({ type: 'error', ok: false, code: 'agent_recovery_not_authorized' });
    expect(await agentRow(ws.workspaceId, 'restarted')).toEqual(before);

    const recovered = await send(alpha, {
      id: 'recover', type: 'agent.recover', name: 'restarted', expected_agent_id: before.id,
      session_ref: 'session-restarted', resumable: true,
    });
    expect(recovered).toMatchObject({
      type: 'reply', ok: true,
      data: { agent_id: before.id, name: 'restarted' },
    });
    expect((recovered?.data as { token?: string }).token).toMatch(/^at_live_/);

    const after = await agentRow(ws.workspaceId, 'restarted');
    expect(after.id).toBe(before.id);
    expect(after.locationNodeId).toBe('node_alpha');
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(after.previousTokenHash).toBe(before.tokenHash);
  });
});
