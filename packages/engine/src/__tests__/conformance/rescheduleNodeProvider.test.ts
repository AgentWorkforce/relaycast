import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { rescheduleInvocationsForLostNode } from '../../engine/action.js';
import { actionInvocations, nodes } from '../../db/schema.js';

type Cap = { name: string; kind?: string; queue?: boolean };

// When a node hosting an invoked node-scoped action dies, the engine reschedules
// onto another node that owns the action. That dispatch must target the provider
// that owns the action on the CHOSEN node — a multi-provider node (broker +
// fleet) otherwise falls back to the default provider (the broker), which
// rejects the action with handler_unavailable and loops the invocation forever.
describe('reschedule targets the action-owning provider on the fallback node', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function enrollNode(wsKey: string, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wsKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  function registerFrame(nodeId: string, name: string, provider: { name: string; instance_id: string } | undefined, caps: Cap[]) {
    return JSON.stringify({
      v: 1, id: `reg-${provider?.name ?? 'default'}`, type: 'node.register', name, node_id: nodeId,
      ...(provider ? { provider } : {}), capabilities: caps, max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    });
  }

  async function attachProvider(wsId: string, nodeId: string, nodeName: string, providerName: string, caps: Cap[]) {
    const provider = { name: providerName, instance_id: `${providerName}-i1` };
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(wsId, nodeId, sock);
    await handle.handleMessage(registerFrame(nodeId, nodeName, provider, caps));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', provider, load: 0, active_agents: 0, handlers_live: true }));
    return { sock, handle };
  }

  async function invokeWork(callerToken: string, job: number): Promise<string> {
    const res = await stack.app.request('/v1/nodes/alpha/actions/work/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${callerToken}` },
      body: JSON.stringify({ input: { job } }),
    });
    expect(res.status).toBe(201);
    return (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
  }

  it('dispatches the rescheduled action to the fleet provider, not the fallback node\'s broker', async () => {
    const ws = await createWorkspace(stack.app, 'resched');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');

    // node_a owns `work` via a fleet provider.
    const aFleet = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'fleet-a', [{ name: 'work', kind: 'action' }]);
    // node_b is multi-provider: a default/broker provider AND a fleet provider
    // that owns `work`.
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bFleet = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action' }]);

    // Invoke `work` on node_a.
    const invocationId = await invokeWork(caller.token, 1);
    expect(aFleet.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'work' });

    // node_a dies; reschedule its open invocations.
    bFleet.sock.received.length = 0;
    bBroker.sock.received.length = 0;
    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBeGreaterThanOrEqual(1);

    // The reschedule reached node_b's fleet provider (which owns `work`), not
    // its broker/default provider.
    expect(bFleet.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'work' });
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);
  });

  it('skips an offline non-queued owner and dispatches to the next live provider', async () => {
    const ws = await createWorkspace(stack.app, 'resched-next');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');
    await enrollNode(ws.workspaceKey, 'node_c', 'gamma');

    const aFleet = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'fleet-a', [{ name: 'work', kind: 'action' }]);
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bFleet = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action' }]);
    const cFleet = await attachProvider(ws.workspaceId, 'node_c', 'gamma', 'fleet-c', [{ name: 'work', kind: 'action' }]);

    const invocationId = await invokeWork(caller.token, 2);
    expect(aFleet.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId });
    await bFleet.handle.handleClose();
    bBroker.sock.received.length = 0;
    cFleet.sock.received.length = 0;

    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBe(1);
    expect(cFleet.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'work' });
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);

    const [invocation] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, dispatchedNodeId: actionInvocations.dispatchedNodeId })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toMatchObject({ status: 'dispatched', dispatchedNodeId: 'node_c' });

    const reconnected = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action' }]);
    expect(reconnected.sock.ofType('action.invoke')).toHaveLength(0);
  });

  it('skips a connected owner whose handlers are not live', async () => {
    const ws = await createWorkspace(stack.app, 'resched-handler-live');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');
    await enrollNode(ws.workspaceKey, 'node_c', 'gamma');

    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'fleet-a', [{ name: 'work', kind: 'action' }]);
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bFleet = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action' }]);
    const cFleet = await attachProvider(ws.workspaceId, 'node_c', 'gamma', 'fleet-c', [{ name: 'work', kind: 'action' }]);
    const invocationId = await invokeWork(caller.token, 3);

    await bFleet.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider: { name: 'fleet-b', instance_id: 'fleet-b-i1' },
      load: 0,
      active_agents: 0,
      handlers_live: false,
    }));
    bFleet.sock.received.length = 0;
    bBroker.sock.received.length = 0;
    cFleet.sock.received.length = 0;

    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBe(1);
    expect(bFleet.sock.ofType('action.invoke')).toHaveLength(0);
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);
    expect(cFleet.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'work' });
  });

  it('queues on an offline owning provider only when the action opts in', async () => {
    const ws = await createWorkspace(stack.app, 'resched-queue');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');

    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'fleet-a', [{ name: 'work', kind: 'action' }]);
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bFleet = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action', queue: true }]);
    const invocationId = await invokeWork(caller.token, 4);
    await bFleet.handle.handleClose();
    bBroker.sock.received.length = 0;

    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBe(1);
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);

    let [invocation] = await stack.runtime.handle.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        completedAt: actionInvocations.completedAt,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toMatchObject({ status: 'pending', error: null, completedAt: null, dispatchedNodeId: 'node_b' });

    const reconnected = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action', queue: true }]);
    for (let i = 0; i < 50 && reconnected.sock.ofType('action.invoke').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reconnected.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'work' });
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);

    [invocation] = await stack.runtime.handle.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        completedAt: actionInvocations.completedAt,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toMatchObject({ status: 'dispatched', error: null, completedAt: null, dispatchedNodeId: 'node_b' });
  });

  it('waits for handlers_live before draining an opted-in provider queue', async () => {
    const ws = await createWorkspace(stack.app, 'resched-handler-queue');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');

    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'fleet-a', [{ name: 'work', kind: 'action' }]);
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bFleet = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action', queue: true }]);
    const invocationId = await invokeWork(caller.token, 5);

    await bFleet.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider: { name: 'fleet-b', instance_id: 'fleet-b-i1' },
      load: 0,
      active_agents: 0,
      handlers_live: false,
    }));
    bFleet.sock.received.length = 0;
    bBroker.sock.received.length = 0;

    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBe(1);
    expect(bFleet.sock.ofType('action.invoke')).toHaveLength(0);
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);

    const [pending] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, dispatchedNodeId: actionInvocations.dispatchedNodeId })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(pending).toMatchObject({ status: 'pending', dispatchedNodeId: 'node_b' });

    await bFleet.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider: { name: 'fleet-b', instance_id: 'fleet-b-i1' },
      load: 0,
      active_agents: 0,
      handlers_live: true,
    }));
    for (let i = 0; i < 50 && bFleet.sock.ofType('action.invoke').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bFleet.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'work' });
  });

  it('releases native capacity when a spawn retry enters a provider shadow', async () => {
    const ws = await createWorkspace(stack.app, 'resched-shadow');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');

    const aBroker = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bPolicy = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'policy', [{ name: 'spawn:claude', kind: 'action' }]);

    const invoke = await stack.app.request('/v1/nodes/alpha/actions/spawn:claude/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { name: 'worker-1' } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(aBroker.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'spawn:claude' });
    bBroker.sock.received.length = 0;
    bPolicy.sock.received.length = 0;

    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBe(1);
    expect(bPolicy.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId, action: 'spawn:claude' });
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);

    const [fallback] = await stack.runtime.handle.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_b')));
    expect(fallback.reservedAgents).toBe(0);
  });

  it('fails once all non-queued owning providers are unavailable', async () => {
    const ws = await createWorkspace(stack.app, 'resched-fail');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws.workspaceKey, 'node_a', 'alpha');
    await enrollNode(ws.workspaceKey, 'node_b', 'beta');

    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'fleet-a', [{ name: 'work', kind: 'action' }]);
    const bBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    const bFleet = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'fleet-b', [{ name: 'work', kind: 'action' }]);
    const invocationId = await invokeWork(caller.token, 6);
    await bFleet.handle.handleClose();
    bBroker.sock.received.length = 0;

    const rescheduled = await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, ws.workspaceId, 'node_a');
    expect(rescheduled).toBe(0);
    expect(bBroker.sock.ofType('action.invoke')).toHaveLength(0);

    const [invocation] = await stack.runtime.handle.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        completedAt: actionInvocations.completedAt,
        dispatchAttempts: actionInvocations.dispatchAttempts,
        attemptedNodeIds: actionInvocations.attemptedNodeIds,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toMatchObject({
      status: 'failed',
      error: 'handler_unavailable',
      dispatchAttempts: 1,
      attemptedNodeIds: ['node_a'],
    });
    expect(invocation.completedAt).toBeInstanceOf(Date);
  });
});
