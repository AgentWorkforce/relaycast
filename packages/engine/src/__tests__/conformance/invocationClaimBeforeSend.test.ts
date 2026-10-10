import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drainNodeInvocations, rescheduleNodeInvocation, sweepTimedOutInvocations } from '../../engine/action.js';
import { exclusiveClaimWrite } from '../../engine/invocationClaim.js';
import { actionInvocations, actions, agents, nodes } from '../../db/schema.js';
import { attachDirectNodeSocket, createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

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

  it('keeps an unset deadline unset when the attempt count changes', () => {
    expect(exclusiveClaimWrite({
      observedStatus: 'pending',
      observedRetryAfterAt: null,
      observedDispatchAttempts: 0,
      nextStatus: 'pending',
      nextRetryAfterAt: null,
      incrementAttempts: true,
    })).toEqual({ retryAfterAt: null, dispatchAttempts: 1 });
  });

  it('moves the deadline only when status and the attempt count would stay put', () => {
    const observed = new Date('2026-10-10T00:00:00.000Z');
    const write = exclusiveClaimWrite({
      observedStatus: 'pending',
      observedRetryAfterAt: observed,
      observedDispatchAttempts: 1,
      nextStatus: 'pending',
      nextRetryAfterAt: new Date(observed.getTime() + 100),
      incrementAttempts: false,
    });
    expect(write.dispatchAttempts).toBe(1);
    expect(write.retryAfterAt?.getTime()).toBe(observed.getTime() + 1000);
  });

  it('sends one frame when two schedulers both leave the row pending', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-claim-pending');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const nodeId = 'node_spawn_pending_claim';
    const sock = await registerSpawnNode(stack, ws, nodeId, 'spawn-pending');
    const db = stack.runtime.handle.db;
    const invocationId = 'inv_spawn_pending_claim';
    await db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'spawn:claude',
      invocationOrigin: 'builtin',
      callerId: caller.agentId,
      callerName: caller.name,
      input: { cli: 'claude', name: 'worker-pending', task: 'hi' },
      status: 'pending',
      dispatchedNodeId: nodeId,
      attemptedNodeIds: [nodeId],
      dispatchAttempts: 1,
      retryAfterAt: new Date(Date.now() - 1_000),
    });
    const [invocation] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    const realtime = stack.runtime.realtime;
    vi.spyOn(realtime, 'isProviderConnected').mockReturnValue(false);
    const originalSend = realtime.sendToProvider.bind(realtime);
    vi.spyOn(realtime, 'sendToProvider').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalSend(...args);
    });

    await Promise.all([
      rescheduleNodeInvocation(db, realtime, invocation!, { allowAttemptedFallback: true }),
      rescheduleNodeInvocation(db, realtime, invocation!, { allowAttemptedFallback: true }),
    ]);

    const frames = sock.ofType('action.invoke').filter((frame) => frame.invocation_id === invocationId);
    expect(frames).toHaveLength(1);
    const [node] = await db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId)));
    expect(node?.reservedAgents).toBe(1);
    const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    expect(row?.status).toBe('pending');
    expect(row?.spawnReservedAt).toBeInstanceOf(Date);
    expect(row?.dispatchAttempts).toBe(2);
  });

  it('retries a dispatched native spawn onto another node once', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-claim-dispatched');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const sockA = await registerSpawnNode(stack, ws, 'node_spawn_a', 'spawn-a');
    const sockB = await registerSpawnNode(stack, ws, 'node_spawn_b', 'spawn-b');
    const db = stack.runtime.handle.db;
    const invocationId = 'inv_spawn_dispatched_retry';
    await db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'spawn:claude',
      invocationOrigin: 'builtin',
      callerId: caller.agentId,
      callerName: caller.name,
      input: { cli: 'claude', name: 'worker-retry', task: 'hi' },
      status: 'dispatched',
      dispatchedAt: new Date(Date.now() - 60_000),
      retryAfterAt: new Date(Date.now() - 1_000),
      dispatchedNodeId: 'node_spawn_a',
      attemptedNodeIds: ['node_spawn_a'],
      dispatchAttempts: 1,
      spawnReservedAt: new Date(Date.now() - 60_000),
    });
    await db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_spawn_a')));

    await Promise.all([
      sweepTimedOutInvocations(db, stack.runtime.realtime),
      sweepTimedOutInvocations(db, stack.runtime.realtime),
    ]);

    expect(sockA.ofType('action.invoke').filter((frame) => frame.invocation_id === invocationId)).toHaveLength(0);
    expect(sockB.ofType('action.invoke').filter((frame) => frame.invocation_id === invocationId)).toHaveLength(1);
    const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    expect(row?.status).toBe('dispatched');
    expect(row?.dispatchedNodeId).toBe('node_spawn_b');
    expect(row?.dispatchAttempts).toBe(2);
    const reserved = await db
      .select({ id: nodes.id, reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(eq(nodes.workspaceId, ws.workspaceId));
    const byId = new Map(reserved.map((node) => [node.id, node.reservedAgents]));
    expect(byId.get('node_spawn_a')).toBe(0);
    expect(byId.get('node_spawn_b')).toBe(1);
  });

  it('retries a dispatched agent-hosted action once', async () => {
    const ws = await createWorkspace(stack.app, 'agent-claim-dispatched');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    const { sock, nodeId } = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const db = stack.runtime.handle.db;
    await db
      .update(agents)
      .set({ locationType: 'via_node', locationNodeId: nodeId, providerName: 'default', status: 'active' })
      .where(eq(agents.id, handler.agentId));
    await db.insert(actions).values({
      id: 'act_claim_retry',
      workspaceId: ws.workspaceId,
      name: 'echo',
      description: 'retry',
      handlerAgentId: handler.agentId,
    });
    const invocationId = 'inv_agent_claim_retry';
    await db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionId: 'act_claim_retry',
      actionName: 'echo',
      invocationOrigin: 'registered_action',
      callerId: caller.agentId,
      callerName: caller.name,
      handlerAgentId: handler.agentId,
      handlerNodeId: nodeId,
      input: { value: 1 },
      status: 'dispatched',
      dispatchedAt: new Date(Date.now() - 60_000),
      retryAfterAt: new Date(Date.now() - 5_000),
      dispatchedNodeId: nodeId,
      dispatchedProvider: 'default',
      dispatchAttempts: 1,
      providerAcceptedAttempt: 1,
      attemptedNodeIds: [nodeId],
    });
    const [invocation] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));

    await Promise.all([
      rescheduleNodeInvocation(db, stack.runtime.realtime, invocation!),
      rescheduleNodeInvocation(db, stack.runtime.realtime, invocation!),
    ]);

    const frames = sock.ofType('action.invoke').filter((frame) => frame.invocation_id === invocationId);
    expect(frames).toHaveLength(1);
    const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    expect(row?.status).toBe('dispatched');
    expect(row?.dispatchAttempts).toBe(2);
    expect(row?.providerAcceptedAttempt).toBe(row?.dispatchAttempts);
  });

  it('releases a spawn claim when the send throws and a later drain sends once', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-claim-throw');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const nodeId = 'node_spawn_throw';
    const sock = await registerSpawnNode(stack, ws, nodeId, 'spawn-throw');
    const db = stack.runtime.handle.db;
    const invocationId = 'inv_spawn_claim_throw';
    await db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'spawn:claude',
      invocationOrigin: 'builtin',
      callerId: caller.agentId,
      callerName: caller.name,
      input: { cli: 'claude', name: 'worker-throw', task: 'hi' },
      status: 'pending',
      dispatchedNodeId: nodeId,
      attemptedNodeIds: [nodeId],
      dispatchAttempts: 1,
      retryAfterAt: new Date(Date.now() - 1_000),
    });
    const realtime = stack.runtime.realtime;
    const rejected = vi.spyOn(realtime, 'sendToProvider').mockRejectedValueOnce(new Error('socket lost before send'));

    await drainNodeInvocations(db, realtime, ws.workspaceId, nodeId);

    expect(sock.ofType('action.invoke')).toHaveLength(0);
    const [node] = await db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId)));
    expect(node?.reservedAgents).toBe(0);
    const [restored] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    expect(restored?.status).toBe('pending');
    expect(restored?.spawnReservedAt).toBeNull();
    expect(restored?.dispatchAttempts).toBe(1);

    rejected.mockRestore();
    await drainNodeInvocations(db, realtime, ws.workspaceId, nodeId);
    expect(sock.ofType('action.invoke').filter((frame) => frame.invocation_id === invocationId)).toHaveLength(1);
    const [after] = await db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId)));
    expect(after?.reservedAgents).toBe(1);
  });

  it('does not let a failed send restore a newer claim', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-claim-newer');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const nodeId = 'node_spawn_newer';
    await registerSpawnNode(stack, ws, nodeId, 'spawn-newer');
    const db = stack.runtime.handle.db;
    const invocationId = 'inv_spawn_claim_newer';
    await db.insert(actionInvocations).values({
      id: invocationId,
      workspaceId: ws.workspaceId,
      actionName: 'spawn:claude',
      invocationOrigin: 'builtin',
      callerId: caller.agentId,
      callerName: caller.name,
      input: { cli: 'claude', name: 'worker-newer', task: 'hi' },
      status: 'pending',
      dispatchedNodeId: nodeId,
      attemptedNodeIds: [nodeId],
      dispatchAttempts: 1,
      retryAfterAt: new Date(Date.now() - 1_000),
    });
    const newerDeadline = new Date(Date.now() + 120_000);
    vi.spyOn(stack.runtime.realtime, 'sendToProvider').mockImplementation(async () => {
      await db
        .update(actionInvocations)
        .set({ status: 'dispatched', dispatchAttempts: 99, retryAfterAt: newerDeadline, dispatchedAt: new Date() })
        .where(eq(actionInvocations.id, invocationId));
      throw new Error('send failed after a newer claim');
    });

    await drainNodeInvocations(db, stack.runtime.realtime, ws.workspaceId, nodeId);

    const [row] = await db.select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    expect(row?.status).toBe('dispatched');
    expect(row?.dispatchAttempts).toBe(99);
    expect(row?.retryAfterAt?.getTime()).toBe(Math.floor(newerDeadline.getTime() / 1000) * 1000);
  });
});

async function registerSpawnNode(
  stack: TestStack,
  ws: { workspaceKey: string; workspaceId: string },
  nodeId: string,
  name: string,
): Promise<FakeSocket> {
  const create = await stack.app.request('/v1/nodes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
    body: JSON.stringify({
      node_id: nodeId,
      name,
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
    id: `reg-${nodeId}`,
    type: 'node.register',
    name,
    node_id: nodeId,
    capabilities: [{ name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } }],
    max_agents: 4,
    tags: ['test'],
    version: 'test-node',
    resume_cursor: null,
  }));
  await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', active_agents: 0, handlers_live: true }));
  await stack.settle();
  return sock;
}
