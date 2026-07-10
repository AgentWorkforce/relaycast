import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { rescheduleInvocationsForLostNode } from '../../engine/action.js';

type Cap = { name: string; kind?: string };

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
    const res = await stack.app.request('/v1/nodes/alpha/actions/work/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { job: 1 } }),
    });
    expect(res.status).toBe(201);
    const invocationId = (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
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
});
