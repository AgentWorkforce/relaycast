import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, ne, sql } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { agents, channelMembers, channels, deliveries, dmConversations, dmParticipants, messages, nodes } from '../../db/tables.js';
import { configureNodeLiveness, nodeLive } from '../../engine/nodeLiveness.js';
import { createGroupDm, postGroupMessage } from '../../engine/groupDm.js';
import { postReply } from '../../engine/thread.js';
import { postMessage } from '../../engine/message.js';
import { prepareAuthorityFanout } from '../../engine/deliveryWrites.js';
import type { EngineDb } from '../../ports/database.js';
import type { NodeLivenessSnapshot } from '../../ports/nodeLiveness.js';

const mailbox = { ttlMs: 60_000, depthCap: 3, offlineExcludeMs: 1_000 };
const online = (): NodeLivenessSnapshot => ({ status: 'online', providers: [{
  name: 'default', live: true, handlers_live: true,
  last_received_at: Date.now(), expires_at: Date.now() + 45_000,
}] });

describe('authority fanout recipient preservation', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  async function seed() {
    const ws = await createWorkspace(stack.app, 'authority-fanout-regression');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const recipient = await registerAgent(stack.app, ws.workspaceKey, 'quiet');
    const db = stack.runtime.deps.db;
    const [node] = await db.insert(nodes).values({
      id: 'nd_quiet', workspaceId: ws.workspaceId, name: 'quiet-node', tokenHash: 'quiet-hash',
      status: 'online', role: 'broker', lastHeartbeatAt: new Date(Date.now() - 300_000),
    }).returning();
    await db.update(agents).set({
      locationType: 'via_node', locationNodeId: node.id, providerName: 'default',
      lastSeen: new Date(Date.now() - 86_400_000),
    }).where(eq(agents.id, recipient.agentId));
    return { ws, sender, recipient, db, node };
  }

  it('uses DM participants rather than the backing channel membership for group-DM thread replies', async () => {
    const { ws, sender, recipient, db } = await seed();
    const conversation = await createGroupDm(db, ws.workspaceId, sender.agentId, { participants: ['quiet'] });
    const parent = await postGroupMessage(db, ws.workspaceId, conversation.id, sender.agentId, { text: 'root' }, { mailbox: { ...mailbox, offlineExcludeMs: 0 } });
    expect(await db.select().from(channelMembers).where(eq(channelMembers.channelId, conversation.channel_id))).toEqual([]);
    configureNodeLiveness(db, { inspect: async () => online() });
    const reply = await postReply(db, ws.workspaceId, parent.id, sender.agentId, { text: 'thread reply' }, { mailbox });
    expect(reply._deliveries.map(delivery => delivery.agentId)).toContain(recipient.agentId);
    expect(await db.select().from(deliveries).where(and(eq(deliveries.messageId, reply.id), eq(deliveries.agentId, recipient.agentId))))
      .toEqual([expect.objectContaining({ status: 'queued', reason: 'dm' })]);
  });

  it('queues quiet recipients on unknown authority without certifying a live route, but excludes confirmed offline recipients', async () => {
    const { ws, sender, recipient, db, node } = await seed();
    const offline = await registerAgent(stack.app, ws.workspaceKey, 'offline');
    await db.insert(nodes).values({ id: 'nd_offline', workspaceId: ws.workspaceId, name: 'offline-node', tokenHash: 'offline-hash', status: 'offline' });
    await db.update(agents).set({ locationType: 'via_node', locationNodeId: 'nd_offline', providerName: 'default', lastSeen: new Date(Date.now() - 86_400_000) }).where(eq(agents.id, offline.agentId));
    await db.insert(channels).values({ id: 'channel', workspaceId: ws.workspaceId, name: 'fanout' });
    await db.insert(channelMembers).values([sender, recipient, offline].map(agent => ({ channelId: 'channel', agentId: agent.agentId })));
    configureNodeLiveness(db, { inspect: async (_workspace, id) => id === node.id ? { status: 'unknown', providers: [] } : { status: 'offline', providers: [] } });
    const result = await postMessage(db, ws.workspaceId, 'channel', sender.agentId, { text: 'keep intended audience' }, { mailbox });
    expect(await nodeLive(db, node)).toBe(false);
    expect(result._deliveries.map(delivery => delivery.agentId)).toEqual([recipient.agentId]);
    expect(result._delivery_rejections).toEqual([expect.objectContaining({ agentId: offline.agentId, reason: 'recipient_offline' })]);
    expect(await db.select().from(deliveries).where(eq(deliveries.messageId, result.id)))
      .toEqual([expect.objectContaining({ agentId: recipient.agentId, status: 'queued' })]);
  });

  it('keeps unknown-authority fanout inside the atomic workspace growth quota', async () => {
    const { ws, sender, recipient, db } = await seed();
    await db.insert(channels).values({ id: 'channel', workspaceId: ws.workspaceId, name: 'bounded' });
    await db.insert(channelMembers).values([sender, recipient].map(agent => ({ channelId: 'channel', agentId: agent.agentId })));
    configureNodeLiveness(db, { inspect: async () => { throw new Error('temporary authority outage'); } });
    const options = { mailbox, workspaceDeliveryPolicy: { cap: 1, reserve: 0 } };
    const first = await postMessage(db, ws.workspaceId, 'channel', sender.agentId, { text: 'first' }, options);
    expect(first._deliveries.map(delivery => delivery.agentId)).toEqual([recipient.agentId]);
    await expect(postMessage(db, ws.workspaceId, 'channel', sender.agentId, { text: 'must roll back' }, options))
      .rejects.toMatchObject({ code: 'workspace_delivery_depth_exceeded' });
    expect(await db.select().from(deliveries).where(eq(deliveries.workspaceId, ws.workspaceId))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.workspaceId, ws.workspaceId))).toHaveLength(1);
  });

  // The pre-fix shape: roster-driven, membership probed per agent.
  async function rosterDrivenAudience(db: EngineDb, workspaceId: string, membership: 'channel' | 'dm', id: string) {
    const audience = membership === 'dm'
      ? sql`EXISTS (SELECT 1 FROM ${dmParticipants} WHERE ${dmParticipants.conversationId} = ${id} AND ${dmParticipants.agentId} = ${agents.id})`
      : sql`EXISTS (SELECT 1 FROM ${channelMembers} WHERE ${channelMembers.channelId} = ${id} AND ${channelMembers.agentId} = ${agents.id})`;
    const rows = await db.select({ agentId: agents.id, nodeId: nodes.id, providerName: agents.providerName })
      .from(agents).innerJoin(nodes, and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, agents.locationNodeId)))
      .where(and(eq(agents.workspaceId, workspaceId), ne(agents.status, 'released'), eq(agents.locationType, 'via_node'), audience));
    return rows.map(row => `${row.agentId}@${row.nodeId}/${row.providerName}`).sort();
  }

  it('resolves the same recipients as the roster-driven query when driven from the audience', async () => {
    const { ws, sender, recipient, db, node } = await seed();
    const other = await createWorkspace(stack.app, 'authority-fanout-other');
    await db.insert(nodes).values([
      { id: 'nd_second', workspaceId: ws.workspaceId, name: 'second-node', tokenHash: 'second-hash' },
      { id: 'nd_foreign', workspaceId: other.workspaceId, name: 'foreign-node', tokenHash: 'foreign-hash' },
    ]);
    const agent = (id: string, workspaceId: string, values: Partial<typeof agents.$inferInsert>) =>
      ({ id, workspaceId, name: id, tokenHash: `${id}-hash`, providerName: 'default', ...values });
    await db.insert(agents).values([
      agent('ag_second', ws.workspaceId, { locationType: 'via_node', locationNodeId: 'nd_second', providerName: 'custom', status: 'offline' }),
      agent('ag_released', ws.workspaceId, { locationType: 'via_node', locationNodeId: node.id, status: 'released' }),
      agent('ag_local', ws.workspaceId, { locationNodeId: node.id }),
      agent('ag_foreign_node', ws.workspaceId, { locationType: 'via_node', locationNodeId: 'nd_foreign' }),
      agent('ag_non_member', ws.workspaceId, { locationType: 'via_node', locationNodeId: node.id }),
      agent('ag_other_ws', other.workspaceId, { locationType: 'via_node', locationNodeId: 'nd_foreign' }),
    ]);
    const audience = [sender.agentId, recipient.agentId, 'ag_second', 'ag_released', 'ag_local', 'ag_foreign_node', 'ag_other_ws'];
    await db.insert(channels).values([
      { id: 'channel', workspaceId: ws.workspaceId, name: 'fanout' },
      { id: 'empty', workspaceId: ws.workspaceId, name: 'empty' },
      { id: 'dm_channel', workspaceId: ws.workspaceId, name: 'dm-backing', channelType: 1 },
    ]);
    await db.insert(channelMembers).values(audience.map(agentId => ({ channelId: 'channel', agentId })));
    await db.insert(dmConversations).values({ id: 'dm', workspaceId: ws.workspaceId, channelId: 'dm_channel', dmType: 'group' });
    await db.insert(dmParticipants).values(audience.map(agentId => ({ conversationId: 'dm', agentId })));
    configureNodeLiveness(db, { inspect: async () => ({ status: 'unknown', providers: [] }) });
    const fanout = async (audience: Parameters<typeof prepareAuthorityFanout>[2]) =>
      (await prepareAuthorityFanout(db, ws.workspaceId, audience)).map(lease => `${lease.agentId}@${lease.nodeId}/${lease.providerName}`).sort();

    // Registration binds the sender to its own direct node, so it is a recipient too.
    const [self] = await db.select().from(agents).where(eq(agents.id, sender.agentId));
    const expected = [`${self.id}@${self.locationNodeId}/${self.providerName}`, `${recipient.agentId}@${node.id}/default`, 'ag_second@nd_second/custom'].sort();
    expect(expected).toHaveLength(3);
    expect(await rosterDrivenAudience(db, ws.workspaceId, 'channel', 'channel')).toEqual(expected);
    expect(await fanout({ channelId: 'channel' })).toEqual(expected);
    expect(await rosterDrivenAudience(db, ws.workspaceId, 'dm', 'dm')).toEqual(expected);
    expect(await fanout({ conversationId: 'dm' })).toEqual(expected);
    expect(await fanout({ channelId: 'empty' })).toEqual([]);
    // Scoping comes from agents/nodes, not the audience row, in both shapes.
    const foreign = (await prepareAuthorityFanout(db, other.workspaceId, { channelId: 'channel' })).map(lease => `${lease.agentId}@${lease.nodeId}/${lease.providerName}`);
    expect(foreign).toEqual(await rosterDrivenAudience(db, other.workspaceId, 'channel', 'channel'));
    expect(foreign).toEqual(['ag_other_ws@nd_foreign/default']);
  });
});
