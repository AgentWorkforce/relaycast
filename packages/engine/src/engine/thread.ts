import { eq, and, sql, lt, gt } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, channelMembers, deliveries } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { displayAgentName, publicMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';

type Db = ReturnType<typeof getDb>;

export async function postReply(
  db: Db,
  workspaceId: string,
  parentId: string,
  agentId: string,
  data: { text: string; blocks?: unknown[] | null; data?: Record<string, unknown> | null },
) {
  // Get the parent message
  const [parent] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, parentId), eq(messages.workspaceId, workspaceId)));

  if (!parent) {
    const err = new Error('Parent message not found');
    Object.assign(err, { code: 'message_not_found', status: 404 });
    throw err;
  }

  // If parent itself has a thread_id, resolve to root (reply-to-reply goes to original parent)
  const threadId = parent.threadId || parent.id;

  const [ch] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, parent.channelId));

  const replyId = generateId();
  const metadata = sanitizeUserMessageMetadata(data.data);
  const [reply] = await db
    .insert(messages)
    .values({
      id: replyId,
      workspaceId,
      channelId: parent.channelId,
      agentId,
      threadId,
      body: data.text,
      blocks: data.blocks || null,
      metadata,
      hasAttachments: false,
    })
    .returning();

  // Resolve agent name + create per-recipient delivery records for all channel members except sender
  const [[agent], channelMemberRows] = await Promise.all([
    db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)),
    db.select({ agentId: channelMembers.agentId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, parent.channelId)),
  ]);

  const recipients = channelMemberRows.filter((m) => m.agentId !== agentId);
  const replyDeliveries: Array<{ id: string; agentId: string }> = [];
  if (recipients.length > 0) {
    const rows = recipients.map((m) => ({
      id: `del_${generateId()}`,
      workspaceId,
      messageId: replyId,
      agentId: m.agentId,
      mode: 'immediate',
      reason: 'thread-reply',
      priority: 'normal',
      status: 'accepted',
    }));
    await db.insert(deliveries).values(rows).onConflictDoNothing();
    replyDeliveries.push(...rows.map((r) => ({ id: r.id, agentId: r.agentId })));
  }

  return {
    id: reply.id,
    channel_id: reply.channelId,
    channel_name: ch?.name,
    agent_id: reply.agentId,
    agent_name: agent?.name || 'unknown',
    thread_id: reply.threadId,
    text: reply.body,
    blocks: (reply.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(reply.metadata),
    has_attachments: reply.hasAttachments,
    created_at: reply.createdAt.toISOString(),
    // Internal: delivery records for recipients — stripped by route before response
    _deliveries: replyDeliveries,
  };
}

export async function getThread(
  db: Db,
  workspaceId: string,
  parentId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

  // Get the parent message with agent name
  const [parent] = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      agentId: messages.agentId,
      agentName: agents.name,
      threadId: messages.threadId,
      body: messages.body,
      blocks: messages.blocks,
      metadata: messages.metadata,
      hasAttachments: messages.hasAttachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(and(eq(messages.id, parentId), eq(messages.workspaceId, workspaceId)));

  if (!parent) {
    const err = new Error('Parent message not found');
    Object.assign(err, { code: 'message_not_found', status: 404 });
    throw err;
  }

  // Get reply count
  const [replyCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.threadId, parentId));

  // Get replies with pagination
  const conditions = [
    eq(messages.threadId, parentId),
    eq(messages.workspaceId, workspaceId),
  ];

  if (opts.before) {
    conditions.push(lt(messages.id, opts.before));
  }
  if (opts.after) {
    conditions.push(gt(messages.id, opts.after));
  }

  const replies = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      agentId: messages.agentId,
      agentName: agents.name,
      threadId: messages.threadId,
      body: messages.body,
      blocks: messages.blocks,
      metadata: messages.metadata,
      hasAttachments: messages.hasAttachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(sql`${messages.id} ASC`)
    .limit(limit);

  return {
    parent: {
      id: parent.id,
      channel_id: parent.channelId,
      agent_id: parent.agentId,
      agent_name: displayAgentName(parent.metadata, parent.agentName),
      text: parent.body,
      blocks: (parent.blocks as unknown[] | null) || null,
      metadata: publicMessageMetadata(parent.metadata),
      has_attachments: parent.hasAttachments,
      thread_id: parent.threadId,
      created_at: parent.createdAt.toISOString(),
      reply_count: replyCount?.count ?? 0,
    },
    replies: replies.map((r) => ({
      id: r.id,
      channel_id: r.channelId,
      agent_id: r.agentId,
      agent_name: displayAgentName(r.metadata, r.agentName),
      thread_id: r.threadId,
      text: r.body,
      blocks: (r.blocks as unknown[] | null) || null,
      metadata: publicMessageMetadata(r.metadata),
      has_attachments: r.hasAttachments,
      created_at: r.createdAt.toISOString(),
    })),
  };
}
