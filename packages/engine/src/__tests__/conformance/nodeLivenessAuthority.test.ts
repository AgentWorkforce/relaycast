import { postMessage } from '../../engine/message.js';
import { listAgents, sweepStaleAgents } from '../../engine/agent.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { nodes, agents, agentNodeBindings, channels, channelMembers } from '../../db/schema.js';
import { configureNodeLiveness, filterAsync, nodeLive, nodeMayOwn, providerLive } from '../../engine/nodeLiveness.js';
import { chooseNodeForAction, claimSpawnNode } from '../../engine/placement.js';
import { getBrokerNodeByMachineId, listNodes, sweepOfflineNodes, bindAgentToNode } from '../../engine/node.js';
import { getPresence } from '../../engine/presence.js';
import type { NodeLivenessSnapshot } from '../../ports/nodeLiveness.js';

const liveSnapshot = (): NodeLivenessSnapshot => ({ status: 'online', providers: [{ name: 'default', connection_id: 'generation-2', last_received_at: Date.now(), expires_at: Date.now() + 45_000, live: true, handlers_live: true }] });

describe('external receipt authority replaces checkpoint freshness', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack?.close(); });
  async function seed() {
    const ws = await createWorkspace(stack.app, 'authority');
    const db = stack.runtime.deps.db;
    const [node] = await db.insert(nodes).values({ id: 'nd_authority', workspaceId: ws.workspaceId, name: 'worker', tokenHash: 'hash', machineId: 'machine', status: 'offline', handlersLive: false, capabilities: [{ name: 'spawn' }], lastHeartbeatAt: new Date(Date.now() - 300_000), provenLiveAt: new Date(Date.now() - 300_000) }).returning();
    return { ws, db, node };
  }
  it('selects and reserves a live node despite a five-minute-old offline projection', async () => {
    const { ws, db } = await seed();
    configureNodeLiveness(db, { inspect: async () => liveSnapshot() });
    const chosen = await chooseNodeForAction(db, ws.workspaceId, { actionName: 'spawn' });
    expect(chosen).toMatchObject({ node: { id: 'nd_authority' }, queued: false });
    const claimed = await claimSpawnNode(db, ws.workspaceId, { actionName: 'spawn' });
    expect(claimed).toMatchObject({ node: { id: 'nd_authority', reservedAgents: 1 }, queued: false });
    const page = await listNodes(db, ws.workspaceId, { status: 'online' });
    expect(page.nodes.map(n => n.id)).toContain('nd_authority');
  });
  it('fails dispatch closed on unavailable authority but keeps incumbent ownership', async () => {
    const { ws, db, node } = await seed();
    configureNodeLiveness(db, { inspect: async () => { throw new Error('partition'); } });
    expect(await nodeLive(db, node)).toBe(false);
    expect(await nodeMayOwn(db, node)).toBe(true);
    await expect(chooseNodeForAction(db, ws.workspaceId, { actionName: 'spawn' })).rejects.toThrow('No live node');
    expect((await listNodes(db, ws.workspaceId)).nodes[0]).toMatchObject({ status: 'offline', liveness_status: 'unknown', live: false });
  });
  it('rejects expired leases even if their response says online', async () => {
    const { db, node } = await seed();
    const snapshot = liveSnapshot(); snapshot.providers[0].expires_at = Date.now() - 1;
    configureNodeLiveness(db, { inspect: async () => snapshot });
    expect(await nodeLive(db, node)).toBe(false);
    expect(await providerLive(db, node.workspaceId, node.id, { name: 'default', status: 'online', handlersLive: true, lastHeartbeatAt: new Date() })).toBe(false);
  });
  it('never rotates a machine identity or runs SQL-only offline sweep from stale projection', async () => {
    const { ws, db } = await seed();
    configureNodeLiveness(db, { inspect: async () => liveSnapshot() });
    expect(await getBrokerNodeByMachineId(db, ws.workspaceId, 'machine')).toBeNull();
    expect(await sweepOfflineNodes(db, stack.runtime.deps.nodeConnections)).toBe(0);
  });
  it('gets node-hosted presence from receipt authority, preserving explicit disconnect holds', async () => {
    const { ws, db, node } = await seed();
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'hosted');
    await db.update(agents).set({ locationType: 'via_node', locationNodeId: node.id, providerName: 'default' }).where(eq(agents.id, agent.agentId));
    await db.insert(agentNodeBindings).values({ id: 'binding', workspaceId: ws.workspaceId, agentId: agent.agentId, nodeId: node.id, status: 'active' });
    configureNodeLiveness(db, { inspect: async () => liveSnapshot() });
    const presence = { heartbeat: async () => {}, disconnect: async () => {}, getOnline: async () => [], explicitlyDisconnected: async () => [] as string[] };
    expect(await getPresence(db, presence, ws.workspaceId)).toContainEqual({ agent_id: agent.agentId, agent_name: 'hosted', status: 'online' });
    presence.explicitlyDisconnected = async () => [agent.agentId];
    expect(await getPresence(db, presence, ws.workspaceId)).toContainEqual({ agent_id: agent.agentId, agent_name: 'hosted', status: 'offline' });
  });
  it('retains self-hosted TTL behavior when no authority is bound', async () => {
    const { db, node } = await seed();
    expect(await nodeLive(db, node)).toBe(false);
    configureNodeLiveness(db, { inspect: async () => liveSnapshot() });
    expect(await nodeLive(db, node)).toBe(true);
    configureNodeLiveness(db);
    expect(await nodeLive(db, node)).toBe(false);
  });
  it('bounds simultaneous authority requests to eight', async () => {
    let active = 0; let maximum = 0;
    const rows = Array.from({ length: 33 }, (_, i) => i);
    expect(await filterAsync(rows, async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); --active; return true; })).toEqual(rows);
    expect(maximum).toBe(8);
  });
  it('keeps quiet live recipients while excluding genuinely long-offline fanout', async () => {
    const { ws, db, node } = await seed();
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const live = await registerAgent(stack.app, ws.workspaceKey, 'live');
    const offline = await registerAgent(stack.app, ws.workspaceKey, 'offline');
    await db.insert(nodes).values({ id: 'nd_offline', workspaceId: ws.workspaceId, name: 'dead', tokenHash: 'dead-hash', status: 'offline' });
    await db.update(agents).set({ locationType: 'via_node', locationNodeId: node.id, providerName: 'default', lastSeen: new Date(Date.now() - 86_400_000) }).where(eq(agents.id, live.agentId));
    await db.update(agents).set({ locationType: 'via_node', locationNodeId: 'nd_offline', providerName: 'default', lastSeen: new Date(Date.now() - 86_400_000) }).where(eq(agents.id, offline.agentId));
    await db.insert(channels).values({ id: 'channel_authority', workspaceId: ws.workspaceId, name: 'authority' });
    await db.insert(channelMembers).values([sender, live, offline].map(a => ({ channelId: 'channel_authority', agentId: a.agentId })));
    configureNodeLiveness(db, { inspect: async (_w,id) => id === node.id ? liveSnapshot() : { status: 'offline', providers: [] } });
    const result = await postMessage(db, ws.workspaceId, 'channel_authority', sender.agentId, { text: 'hello' }, { mailbox: { ttlMs: 60_000, depthCap: 3, offlineExcludeMs: 1000 } });
    expect(result._deliveries.map(d => d.agentId)).toContain(live.agentId);
    expect(result._deliveries.map(d => d.agentId)).not.toContain(offline.agentId);
    expect(result._delivery_rejections).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: offline.agentId, reason: 'recipient_offline' })]));
  });
  it('preserves quiet hosted work status in agent sweep and roster', async () => {
    const { ws, db, node } = await seed();
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'quiet');
    await db.update(agents).set({ status: 'active', locationType: 'via_node', locationNodeId: node.id, lastSeen: new Date(Date.now() - 86_400_000) }).where(eq(agents.id, agent.agentId));
    configureNodeLiveness(db, { inspect: async () => liveSnapshot() });
    await sweepStaleAgents(db, ws.workspaceId);
    expect((await listAgents(db, ws.workspaceId, 'active')).map(a => a.id)).toContain(agent.agentId);
  });
  it('aborts a cross-node move when incumbent reconnect advances its revision after an offline probe', async () => {
    const { ws, db, node } = await seed();
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'moving');
    await db.update(agents).set({ status: 'active', locationType: 'via_node', locationNodeId: node.id }).where(eq(agents.id, agent.agentId));
    await db.insert(agentNodeBindings).values({ id: 'move-binding', workspaceId: ws.workspaceId, agentId: agent.agentId, nodeId: node.id, status: 'active' });
    await db.insert(nodes).values({ id: 'target', workspaceId: ws.workspaceId, name: 'target', tokenHash: 'target-hash' });
    configureNodeLiveness(db, { inspect: async (_w,id) => {
      if (id === node.id) {
        await db.update(nodes).set({ livenessRevision: sql`${nodes.livenessRevision} + 1` }).where(eq(nodes.id, id));
        return { status: 'offline', providers: [] };
      }
      return liveSnapshot();
    } });
    await expect(bindAgentToNode(db, ws.workspaceId, 'target', 'moving')).rejects.toThrow();
    const [after] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
    expect(after.locationNodeId).toBe(node.id);
  });

});
