import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentNodeBindings, agents, nodeProviders, nodes } from '../../db/schema.js';
import { handleProviderDisconnect, registerAgentViaNode } from '../../engine/node.js';
import { getPresence, nodeHostedPresenceQuery } from '../../engine/presence.js';
import { isNodeLive, NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';
import {
  attachDirectNodeSocket,
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

describe('node-hosted presence', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function stampLiveness(nodeId: string, atMs: number) {
    const at = new Date(atMs);
    await stack.runtime.deps.db.update(nodes).set({
      status: 'online',
      lastHeartbeatAt: at,
    }).where(eq(nodes.id, nodeId));
    await stack.runtime.deps.db.update(nodeProviders).set({
      status: 'online',
      handlersLive: true,
      lastHeartbeatAt: at,
    }).where(eq(nodeProviders.nodeId, nodeId));
  }

  async function enrollBroker(workspaceKey: string, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId,
        name,
        role: 'broker',
        capabilities: [],
        max_agents: 4,
        tags: [],
        version: 'v1',
      }),
    });
    expect(res.status).toBe(201);
  }

  async function registerAndHeartbeat(workspaceId: string, nodeId: string, name: string) {
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, new FakeSocket());
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `reg-${nodeId}`,
      type: 'node.register',
      name,
      node_id: nodeId,
      provider: { name: 'default', instance_id: 'i1' },
      capabilities: [],
      max_agents: 4,
      tags: [],
      version: 'v1',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider: { name: 'default', instance_id: 'i1' },
      active_agents: 1,
      handlers_live: true,
    }));
  }

  async function bind(workspaceKey: string, nodeName: string, agentName: string) {
    const res = await stack.app.request(`/v1/nodes/${nodeName}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ agent_name: agentName }),
    });
    expect(res.status).toBe(201);
  }

  async function presenceByName(workspaceKey: string) {
    const res = await stack.app.request('/v1/agents/presence', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ agent_name: string; status: 'online' | 'offline' }> };
    return new Map(body.data.map((row) => [row.agent_name, row.status]));
  }

  it('counts a via-node agent from node liveness and a binding-less agent from the tracker', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence');
    const hosted = await registerAgent(stack.app, ws.workspaceKey, 'hosted');
    const staleHosted = await registerAgent(stack.app, ws.workspaceKey, 'stale-hosted');
    const direct = await registerAgent(stack.app, ws.workspaceKey, 'direct');

    await enrollBroker(ws.workspaceKey, 'node_live', 'live-broker');
    await registerAndHeartbeat(ws.workspaceId, 'node_live', 'live-broker');
    await bind(ws.workspaceKey, 'live-broker', 'hosted');

    await enrollBroker(ws.workspaceKey, 'node_stale', 'stale-broker');
    await registerAndHeartbeat(ws.workspaceId, 'node_stale', 'stale-broker');
    await bind(ws.workspaceKey, 'stale-broker', 'stale-hosted');
    await stack.runtime.deps.db
      .update(nodes)
      .set({
        status: 'online',
        lastHeartbeatAt: new Date(Date.now() - NODE_LIVENESS_TTL_MS - 1_000),
      })
      .where(eq(nodes.id, 'node_stale'));

    await stack.runtime.deps.db
      .delete(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, direct.agentId),
      ));

    const [liveNode] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_live'));
    const [staleNode] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_stale'));
    expect(isNodeLive(liveNode!)).toBe(true);
    expect(isNodeLive(staleNode!)).toBe(false);
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(hosted.agentId);
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(staleHosted.agentId);
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(direct.agentId);

    const before = await presenceByName(ws.workspaceKey);
    expect(before.get('hosted')).toBe('online');
    expect(before.get('stale-hosted')).toBe('offline');
    expect(before.get('direct')).toBe('offline');
    // The presence read is not an HTTP heartbeat for these agents.
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(hosted.agentId);

    await stack.runtime.deps.db
      .update(agentNodeBindings)
      .set({ status: 'inactive' })
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, hosted.agentId),
        eq(agentNodeBindings.nodeId, 'node_live'),
      ));
    expect((await presenceByName(ws.workspaceKey)).get('hosted')).toBe('offline');
    await stack.runtime.deps.db
      .update(agentNodeBindings)
      .set({ status: 'active' })
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, hosted.agentId),
        eq(agentNodeBindings.nodeId, 'node_live'),
      ));

    const heartbeat = await stack.app.request('/v1/agents/heartbeat', {
      method: 'POST',
      headers: { authorization: `Bearer ${direct.token}` },
    });
    expect(heartbeat.status).toBe(200);
    const after = await presenceByName(ws.workspaceKey);
    expect(after.get('direct')).toBe('online');
    expect(after.get('hosted')).toBe('online');
    expect(after.get('stale-hosted')).toBe('offline');
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).toContain(direct.agentId);
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(hosted.agentId);
  });

  it('follows isNodeLive at the second boundary and does not write on read', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence-boundary');
    const edge = await registerAgent(stack.app, ws.workspaceKey, 'edge');
    const wide = await registerAgent(stack.app, ws.workspaceKey, 'wide');
    const ahead = await registerAgent(stack.app, ws.workspaceKey, 'ahead');
    await enrollBroker(ws.workspaceKey, 'node_edge', 'edge-broker');
    await enrollBroker(ws.workspaceKey, 'node_wide', 'wide-broker');
    await enrollBroker(ws.workspaceKey, 'node_ahead', 'ahead-broker');
    await registerAndHeartbeat(ws.workspaceId, 'node_edge', 'edge-broker');
    await registerAndHeartbeat(ws.workspaceId, 'node_wide', 'wide-broker');
    await registerAndHeartbeat(ws.workspaceId, 'node_ahead', 'ahead-broker');
    await registerAgent(stack.app, ws.workspaceKey, 'provider-stale');
    await enrollBroker(ws.workspaceKey, 'node_provider_stale', 'provider-stale-broker');
    await registerAndHeartbeat(ws.workspaceId, 'node_provider_stale', 'provider-stale-broker');
    await bind(ws.workspaceKey, 'provider-stale-broker', 'provider-stale');
    await bind(ws.workspaceKey, 'edge-broker', 'edge');
    await bind(ws.workspaceKey, 'wide-broker', 'wide');
    await bind(ws.workspaceKey, 'ahead-broker', 'ahead');

    // Not aligned to a second, so a floor() lower bound admits one extra stored second.
    const now = 1_700_000_000_500;
    const liveSecond = Math.ceil((now - NODE_LIVENESS_TTL_MS) / 1000);
    const wideSecond = liveSecond - 1;
    const aheadAt = Math.floor(now / 1000) * 1000 + 1000;
    await stampLiveness('node_edge', liveSecond * 1000);
    await stampLiveness('node_wide', wideSecond * 1000);
    await stampLiveness('node_ahead', aheadAt);
    // The node is inside the TTL; its provider is the extra second the SQL
    // window would admit and isNodeLive/isProviderLive must still reject.
    await stack.runtime.deps.db.update(nodes).set({
      status: 'online',
      lastHeartbeatAt: new Date(liveSecond * 1000),
    }).where(eq(nodes.id, 'node_provider_stale'));
    await stack.runtime.deps.db.update(nodeProviders).set({
      status: 'online',
      handlersLive: true,
      lastHeartbeatAt: new Date(wideSecond * 1000),
    }).where(eq(nodeProviders.nodeId, 'node_provider_stale'));

    const [edgeNode] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_edge'));
    const [wideNode] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_wide'));
    const [aheadNode] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_ahead'));
    expect(isNodeLive(edgeNode!, now)).toBe(true);
    expect(isNodeLive(wideNode!, now)).toBe(false);
    expect(isNodeLive(aheadNode!, now)).toBe(false);

    const before = {
      edge: edgeNode!.lastHeartbeatAt?.getTime(),
      wide: wideNode!.lastHeartbeatAt?.getTime(),
      ahead: aheadNode!.lastHeartbeatAt?.getTime(),
    };
    const rows = await getPresence(stack.runtime.deps.db, stack.runtime.presence, ws.workspaceId, now);
    const status = new Map(rows.map((row) => [row.agent_name, row.status]));
    expect(status.get('edge')).toBe('online');
    expect(status.get('wide')).toBe('offline');
    expect(status.get('ahead')).toBe('offline');
    expect(status.get('provider-stale')).toBe('offline');

    const [edgeAfter] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_edge'));
    const [wideAfter] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_wide'));
    const [aheadAfter] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_ahead'));
    expect(edgeAfter!.lastHeartbeatAt?.getTime()).toBe(before.edge);
    expect(wideAfter!.lastHeartbeatAt?.getTime()).toBe(before.wide);
    expect(aheadAfter!.lastHeartbeatAt?.getTime()).toBe(before.ahead);
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).toEqual([]);
  });

  it('seeks the node heartbeat index and the binding node index', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence-plan');
    const { sql: statement, params } = nodeHostedPresenceQuery(
      stack.runtime.deps.db,
      ws.workspaceId,
      1_700_000_000_500,
    ).toSQL();
    const plan = JSON.stringify(
      stack.runtime.handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(...params),
    );
    expect(plan).toContain('idx_nodes_status_heartbeat');
    expect(plan).toContain('idx_agent_node_bindings_node');
    expect(plan).toContain('node_providers_node_name_unique');
    expect(plan).toContain('idx_node_providers_node');
    expect(plan).not.toContain('SCAN nodes');
    expect(plan).not.toContain('SCAN agent_node_bindings');
    expect(plan).not.toContain('SCAN agents');
    expect(plan).not.toContain('SCAN node_providers');
  });

  it('does not count an agent whose own provider is offline while a sibling keeps the node live', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence-provider');
    await enrollBroker(ws.workspaceKey, 'node_multi', 'multi-broker');
    const py = await attachProvider(ws.workspaceId, 'node_multi', 'multi-broker', 'py');
    await attachProvider(ws.workspaceId, 'node_multi', 'multi-broker', 'rb');
    const worker = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, 'node_multi', 'py', {
      v: 1, type: 'agent.register', name: 'worker', auto_join_general: false,
    });
    const sibling = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, 'node_multi', 'rb', {
      v: 1, type: 'agent.register', name: 'sibling', auto_join_general: false,
    });

    const before = await presenceByName(ws.workspaceKey);
    expect(before.get('worker')).toBe('online');
    expect(before.get('sibling')).toBe('online');
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(worker.agent_id);

    await handleProviderDisconnect(
      stack.runtime.deps.db,
      stack.runtime.realtime,
      ws.workspaceId,
      'node_multi',
      'py',
      true,
    );
    expect(py.handle).toBeDefined();

    const [node] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_multi'));
    const [pyProvider] = await stack.runtime.deps.db.select().from(nodeProviders).where(and(
      eq(nodeProviders.nodeId, 'node_multi'),
      eq(nodeProviders.name, 'py'),
    ));
    const [binding] = await stack.runtime.deps.db.select().from(agentNodeBindings).where(and(
      eq(agentNodeBindings.agentId, worker.agent_id),
      eq(agentNodeBindings.nodeId, 'node_multi'),
    ));
    expect(isNodeLive(node!)).toBe(true);
    expect(pyProvider?.status).toBe('offline');
    expect(binding?.status).toBe('active');

    const after = await presenceByName(ws.workspaceKey);
    expect(after.get('worker')).toBe('offline');
    expect(after.get('sibling')).toBe('online');
  });

  it('does not count an agent a live node omits from its inventory', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence-inventory');
    await enrollBroker(ws.workspaceKey, 'node_inv', 'inventory-broker');
    const broker = await attachProvider(ws.workspaceId, 'node_inv', 'inventory-broker', 'broker');
    const worker = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, 'node_inv', 'broker', {
      v: 1, type: 'agent.register', name: 'worker', auto_join_general: false,
    });
    const helper = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, 'node_inv', 'broker', {
      v: 1, type: 'agent.register', name: 'helper', auto_join_general: false,
    });
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('online');

    await broker.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-helper-only',
      type: 'inventory.sync',
      agents: [{ agent_id: helper.agent_id, name: helper.name, session_ref: 'session-helper' }],
    }));
    expect(broker.sock.ofType('reply').find((frame) => frame.id === 'inventory-helper-only')).toMatchObject({ ok: true });

    const [workerRow] = await stack.runtime.deps.db.select({
      status: agents.status,
      locationNodeId: agents.locationNodeId,
    }).from(agents).where(eq(agents.id, worker.agent_id));
    const [workerBinding] = await stack.runtime.deps.db.select({ status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.agentId, worker.agent_id),
        eq(agentNodeBindings.nodeId, 'node_inv'),
      ));
    expect(workerRow).toMatchObject({ status: 'offline', locationNodeId: null });
    expect(workerBinding?.status).toBe('inactive');

    const after = await presenceByName(ws.workspaceKey);
    expect(after.get('worker')).toBe('offline');
    expect(after.get('helper')).toBe('online');
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(helper.agent_id);
  });

  it('keeps a presence-only disconnect offline until heartbeat or a new inventory route', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence-disconnect');
    await enrollBroker(ws.workspaceKey, 'node_disc', 'disconnect-broker');
    const broker = await attachProvider(ws.workspaceId, 'node_disc', 'disconnect-broker', 'broker');
    const worker = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, 'node_disc', 'broker', {
      v: 1, type: 'agent.register', name: 'worker', auto_join_general: false,
    });
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('online');
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(worker.agent_id);

    const disconnect = await stack.app.request('/v1/agents/disconnect', {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}` },
    });
    expect(disconnect.status).toBe(200);

    const [binding] = await stack.runtime.deps.db.select({ status: agentNodeBindings.status })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.agentId, worker.agent_id),
        eq(agentNodeBindings.nodeId, 'node_disc'),
      ));
    expect(binding?.status).toBe('active');
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('offline');

    await broker.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-still-listed',
      type: 'inventory.sync',
      agents: [{ agent_id: worker.agent_id, name: worker.name, session_ref: 'session-worker' }],
    }));
    expect(broker.sock.ofType('reply').find((frame) => frame.id === 'inventory-still-listed')).toMatchObject({ ok: true });
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('offline');

    const heartbeat = await stack.app.request('/v1/agents/heartbeat', {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}` },
    });
    expect(heartbeat.status).toBe(200);
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('online');

    const again = await stack.app.request('/v1/agents/disconnect', {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}` },
    });
    expect(again.status).toBe(200);
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('offline');

    await broker.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-omitted',
      type: 'inventory.sync',
      agents: [],
    }));
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('offline');
    await broker.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-restored',
      type: 'inventory.sync',
      agents: [{ agent_id: worker.agent_id, name: worker.name, session_ref: 'session-worker' }],
    }));
    expect(broker.sock.ofType('reply').find((frame) => frame.id === 'inventory-restored')).toMatchObject({ ok: true });
    expect((await presenceByName(ws.workspaceKey)).get('worker')).toBe('online');
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(worker.agent_id);
  });

  it('counts an implicit direct node from node liveness when it has no provider row', async () => {
    const ws = await createWorkspace(stack.app, 'node-hosted-presence-direct');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'direct-worker');
    await attachDirectNodeSocket(stack, ws.workspaceId, agent);

    const providers = await stack.runtime.deps.db.select({ id: nodeProviders.id })
      .from(nodeProviders)
      .where(eq(nodeProviders.nodeId, `node_direct_${agent.agentId}`));
    expect(providers).toEqual([]);
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(agent.agentId);
    expect((await presenceByName(ws.workspaceKey)).get('direct-worker')).toBe('online');
  });

  async function attachProvider(workspaceId: string, nodeId: string, nodeName: string, providerName: string) {
    const provider = { name: providerName, instance_id: `${providerName}-i1` };
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `reg-${providerName}`,
      type: 'node.register',
      name: nodeName,
      node_id: nodeId,
      provider,
      capabilities: [{ name: `cap-${providerName}`, kind: 'action' }],
      max_agents: 4,
      tags: [],
      version: 'v1',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider,
      active_agents: 1,
      handlers_live: true,
    }));
    return { sock, handle };
  }
});
