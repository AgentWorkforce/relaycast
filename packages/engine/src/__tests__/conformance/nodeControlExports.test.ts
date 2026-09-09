import { recoverAgentViaNode, registerAgentViaNode } from '../../engine/node.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { handleProviderDisconnect, markNodeOffline } from '../../node-control.js';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { actionInvocations, channelMembers, nodeProviders, nodes } from '../../db/schema.js';

// The provider-disconnect lifecycle is exported from @relaycast/engine/node-control
// so an out-of-process socket owner — the relaycast-cloud NodeDO — drives it on
// socket close instead of hand-rolling the SQL (the mirror the node-providers spec
// is removing). These assert the public exports produce the same DB liveness the
// in-process adapter's own close path produces.
describe('node-control provider-disconnect exports', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  // Optional-chain so a failed beforeEach (undefined stack) surfaces its real
  // error instead of a TypeError from teardown.
  afterEach(() => stack?.close());

  const db = () => stack.runtime.handle.db;

  async function enrollNode(ws: { workspaceKey: string }, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  async function attachProvider(
    workspaceId: string,
    nodeId: string,
    nodeName: string,
    providerName: string,
    capability: string,
    activeAgents = 0,
    instanceId = `${providerName}-i1`,
    kind: 'action' | 'capacity' = 'action',
  ) {
    const provider = { name: providerName, instance_id: instanceId };
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `reg-${instanceId}`,
      type: 'node.register',
      name: nodeName,
      node_id: nodeId,
      provider,
      capabilities: [{ name: capability, kind }],
      max_agents: 4,
      tags: ['test'],
      version: 'v1',
      resume_cursor: null,
    }));
    await heartbeat(handle, providerName, activeAgents, instanceId);
    return { sock, handle };
  }

  function heartbeat(
    handle: { handleMessage(raw: string): Promise<void> },
    providerName: string,
    activeAgents: number,
    instanceId = `${providerName}-i1`,
  ) {
    return handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider: { name: providerName, instance_id: instanceId },
      load: 0,
      active_agents: activeAgents,
      handlers_live: true,
    }));
  }

  it('node registration opts out of general and invalidates the cache for default joins', async () => {
    const ws = await createWorkspace(stack.app, 'node-registration-isolation');
    await enrollNode(ws, 'node-isolation', 'isolation');
    await attachProvider(ws.workspaceId, 'node-isolation', 'isolation', 'broker', 'spawn');
    const readGeneral = async () => {
      const response = await stack.app.request('/v1/channels/general', {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()).data;
    };
    await readGeneral();
    const isolated = await registerAgentViaNode(db(), ws.workspaceId, 'node-isolation', 'broker', {
      v: 1, type: 'agent.register', name: 'isolated-node-agent', auto_join_general: false,
    });
    expect(await db().select().from(channelMembers).where(eq(channelMembers.agentId, isolated.agent_id))).toEqual([]);
    await recoverAgentViaNode(db(), ws.workspaceId, 'node-isolation', 'broker', {
      v: 1, type: 'agent.recover', name: isolated.name, expected_agent_id: isolated.agent_id,
    });
    expect(await db().select().from(channelMembers).where(eq(channelMembers.agentId, isolated.agent_id))).toEqual([]);
    const ordinary = await registerAgentViaNode(db(), ws.workspaceId, 'node-isolation', 'broker', {
      v: 1, type: 'agent.register', name: 'ordinary-node-agent',
    });
    expect((await readGeneral()).members.map((member: { agent_id: string }) => member.agent_id))
      .toContain(ordinary.agent_id);
  });

  it.each([
    [{ verify_ready: true }, true],
    [{ verify_ready: false }, false],
    [{ verifyReady: true }, false],
    [{ agent: { verify_ready: true } }, false],
    [{ harness_config: { metadata: { verify_ready: true } } }, false],
  ])('inventory follows the canonical readiness input: %j', async (readinessInput, verified) => {
    const ws = await createWorkspace(stack.app, `inventory-readiness-${verified}`);
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node-ready', 'ready');
    const provider = await attachProvider(ws.workspaceId, 'node-ready', 'ready', 'broker', 'spawn:claude');
    const response = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { name: 'worker', cli: 'claude', ...readinessInput } }),
    });
    expect(response.status).toBe(201);
    const invocationId = (await response.json()).data.invocation_id;
    const agent = await registerAgentViaNode(db(), ws.workspaceId, 'node-ready', 'broker', {
      v: 1, type: 'agent.register', name: 'worker', invocation_id: invocationId, auto_join_general: false,
    });
    await provider.handle.handleMessage(JSON.stringify({
      v: 1, id: 'inventory', type: 'inventory.sync',
      agents: [{ agent_id: agent.agent_id, name: agent.name, invocation_id: invocationId, session_ref: 'not-readiness' }],
    }));
    expect(provider.sock.ofType('reply').find((frame) => frame.id === 'inventory')).toMatchObject({ ok: true });
    const [invocation] = await db().select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
    expect(invocation.status).toBe(verified ? 'dispatched' : 'completed');
    if (verified) {
      await provider.handle.handleMessage(JSON.stringify({ v: 1, id: 'empty-during-cleanup', type: 'inventory.sync', agents: [] }));
      const [pending] = await db().select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
      expect(pending.status).toBe('dispatched');
      await provider.handle.handleMessage(JSON.stringify({ v: 1, type: 'action.result', invocation_id: invocationId,
        output: { spawned: true, ready: true, name: agent.name } }));
      const [finished] = await db().select().from(actionInvocations).where(eq(actionInvocations.id, invocationId));
      expect(finished.status).toBe('completed');
      expect(finished.output).toMatchObject({ spawned: true, ready: true });
    }
  });

  it.each(['not-live', 'stale'])('verified native spawn checks its own provider: %s', async (state) => {
    const ws = await createWorkspace(stack.app, 'provider-readiness-' + state);
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'multi-provider-node', 'multi');
    const spawn = await attachProvider(ws.workspaceId, 'multi-provider-node', 'multi', 'broker', 'spawn:claude', 0, 'broker-i1', 'capacity');
    await attachProvider(ws.workspaceId, 'multi-provider-node', 'multi', 'other', 'ping');
    await db().update(nodeProviders).set(state === 'stale'
      ? { lastHeartbeatAt: new Date(Date.now() - 300_000) }
      : { handlersLive: false })
      .where(and(eq(nodeProviders.nodeId, 'multi-provider-node'), eq(nodeProviders.name, 'broker')));
    const [aggregate] = await db().select().from(nodes).where(eq(nodes.id, 'multi-provider-node'));
    expect(aggregate.handlersLive).toBe(true);
    const response = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { name: 'worker', cli: 'claude', target_node: 'multi', verify_ready: true } }),
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('spawn_target_unavailable');
    expect(spawn.sock.ofType('action.invoke')).toHaveLength(0);
  });

  function nodeActiveAgents(workspaceId: string, nodeId: string) {
    return db()
      .select({ activeAgents: nodes.activeAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .then((rows) => rows[0]?.activeAgents);
  }

  function providerActiveAgents(workspaceId: string, nodeId: string, name: string) {
    return db()
      .select({ activeAgents: nodeProviders.activeAgents })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId), eq(nodeProviders.name, name)))
      .then((rows) => rows[0]?.activeAgents);
  }

  function providerStatuses(workspaceId: string, nodeId: string) {
    return db()
      .select({ name: nodeProviders.name, status: nodeProviders.status })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId)))
      .then((rows) => Object.fromEntries(rows.map((r) => [r.name, r.status])));
  }

  function nodeStatus(workspaceId: string, nodeId: string) {
    return db()
      .select({ status: nodes.status })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .then((rows) => rows[0]?.status);
  }

  it('handleProviderDisconnect (remaining connections) flips only that provider offline; node stays online', async () => {
    const ws = await createWorkspace(stack.app, 'exp-provider-remaining');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build');

    await handleProviderDisconnect(db(), stack.runtime.realtime, ws.workspaceId, 'node_a', 'py', true);

    expect(await providerStatuses(ws.workspaceId, 'node_a')).toEqual({ py: 'offline', rb: 'online' });
    expect(await nodeStatus(ws.workspaceId, 'node_a')).toBe('online');
  });

  it('handleProviderDisconnect (no remaining connections) marks the whole node offline', async () => {
    const ws = await createWorkspace(stack.app, 'exp-provider-last');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl');

    await handleProviderDisconnect(db(), stack.runtime.realtime, ws.workspaceId, 'node_a', 'py', false);

    expect(await providerStatuses(ws.workspaceId, 'node_a')).toEqual({ py: 'offline' });
    expect(await nodeStatus(ws.workspaceId, 'node_a')).toBe('offline');
  });

  it('markNodeOffline flips the node and every provider offline', async () => {
    const ws = await createWorkspace(stack.app, 'exp-node-offline');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build');

    await markNodeOffline(db(), stack.runtime.realtime, ws.workspaceId, 'node_a');

    expect(await providerStatuses(ws.workspaceId, 'node_a')).toEqual({ py: 'offline', rb: 'offline' });
    expect(await nodeStatus(ws.workspaceId, 'node_a')).toBe('offline');
  });

  it('drops a disconnected provider from the node aggregate, and restores it on reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'exp-aggregate');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl', 2);
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build', 3);
    // The node aggregate sums both providers' active agents.
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(5);

    // py's socket drops (others remain): its agents are gone, so the node
    // aggregate must no longer count them — recomputeNodeAggregate would resurrect
    // them if the provider row kept its stale activeAgents.
    await py.handle.handleClose();
    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'py')).toBe(0);
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(3);

    // Symmetric restore through a real reconnect: a fresh socket registers py
    // (new instance) and heartbeats, repopulating its count.
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl', 2, 'py-i2');
    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'py')).toBe(2);
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(5);
  });

  it('markNodeOffline zeros every provider active-agent count', async () => {
    const ws = await createWorkspace(stack.app, 'exp-node-offline-aggregate');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl', 2);
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build', 3);

    await markNodeOffline(db(), stack.runtime.realtime, ws.workspaceId, 'node_a');

    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'py')).toBe(0);
    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'rb')).toBe(0);
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(0);
  });
});
