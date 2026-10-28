import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { agents, channelMembers, channels, deliveries, messages, nodes } from '../../db/schema.js';
import { configureNodeLiveness, nodeLive } from '../../engine/nodeLiveness.js';
import { createGroupDm, postGroupMessage } from '../../engine/groupDm.js';
import { postReply } from '../../engine/thread.js';
import { postMessage } from '../../engine/message.js';
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
});
