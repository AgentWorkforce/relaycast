import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentNodeBindings, nodes } from '../../db/schema.js';
import { getPresence, nodeHostedPresenceQuery } from '../../engine/presence.js';
import { isNodeLive, NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';
import {
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
    await bind(ws.workspaceKey, 'edge-broker', 'edge');
    await bind(ws.workspaceKey, 'wide-broker', 'wide');
    await bind(ws.workspaceKey, 'ahead-broker', 'ahead');

    // Not aligned to a second, so a floor() lower bound admits one extra stored second.
    const now = 1_700_000_000_500;
    const liveSecond = Math.ceil((now - NODE_LIVENESS_TTL_MS) / 1000);
    const wideSecond = liveSecond - 1;
    await stack.runtime.deps.db.update(nodes).set({
      status: 'online',
      lastHeartbeatAt: new Date(liveSecond * 1000),
    }).where(eq(nodes.id, 'node_edge'));
    await stack.runtime.deps.db.update(nodes).set({
      status: 'online',
      lastHeartbeatAt: new Date(wideSecond * 1000),
    }).where(eq(nodes.id, 'node_wide'));
    await stack.runtime.deps.db.update(nodes).set({
      status: 'online',
      lastHeartbeatAt: new Date(Math.floor(now / 1000) * 1000 + 1000),
    }).where(eq(nodes.id, 'node_ahead'));

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
    expect(plan).not.toContain('SCAN nodes');
    expect(plan).not.toContain('SCAN agent_node_bindings');
  });
});
