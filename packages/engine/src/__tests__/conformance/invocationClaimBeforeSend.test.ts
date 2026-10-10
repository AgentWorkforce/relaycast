import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drainNodeInvocations, sweepTimedOutInvocations } from '../../engine/action.js';
import { actionInvocations, nodes } from '../../db/schema.js';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

// Drain and the timeout sweep both select a due pending spawn and do not share
// a lock. The pending claim has to make one of them the only sender, and the
// loser has to drop the capacity it reserved.
describe('invocation claim before send', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  it('sends one frame and keeps one reservation when drain and sweep overlap', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-claim-before-send');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const nodeId = 'node_spawn_claim';
    const create = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId,
        name: 'spawn-claim',
        capabilities: ['spawn:claude'],
        max_agents: 4,
        tags: ['test'],
        version: 'test-node',
      }),
    });
    expect(create.status).toBe(201);

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'reg-spawn-claim',
      type: 'node.register',
      name: 'spawn-claim',
      node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } }],
      max_agents: 4,
      tags: ['test'],
      version: 'test-node',
      resume_cursor: null,
    }));
    await stack.settle();

    const db = stack.runtime.handle.db;
    const invocationId = 'inv_spawn_claim_before_send';
    await db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'spawn:claude',
      invocationOrigin: 'builtin',
      callerId: caller.agentId,
      callerName: caller.name,
      input: { cli: 'claude', name: 'worker-claim', task: 'hi' },
      status: 'pending',
      dispatchedNodeId: nodeId,
      attemptedNodeIds: [nodeId],
      dispatchAttempts: 1,
      retryAfterAt: new Date(Date.now() - 1_000),
    });

    const realtime = stack.runtime.realtime;
    const originalSend = realtime.sendToProvider.bind(realtime);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let enteredSend!: () => void;
    const sendEntered = new Promise<void>((resolve) => { enteredSend = resolve; });
    let held = false;
    vi.spyOn(realtime, 'sendToProvider').mockImplementation(async (...args) => {
      if (!held) {
        held = true;
        enteredSend();
        await sendGate;
      }
      return originalSend(...args);
    });

    sock.received.length = 0;
    const drainPromise = drainNodeInvocations(db, realtime, ws.workspaceId, nodeId);
    await sendEntered;
    await sweepTimedOutInvocations(db, realtime);
    releaseSend();
    await drainPromise;

    const frames = sock.ofType('action.invoke').filter((frame) => frame.invocation_id === invocationId);
    expect(frames).toHaveLength(1);
    const [node] = await db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId)));
    expect(node?.reservedAgents).toBe(1);
    const [invocation] = await db
      .select({ status: actionInvocations.status, spawnReservedAt: actionInvocations.spawnReservedAt })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation?.status).toBe('dispatched');
    expect(invocation?.spawnReservedAt).toBeInstanceOf(Date);
  });
});
