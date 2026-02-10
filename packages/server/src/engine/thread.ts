import { eq, and, sql, lt, gt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { messages, channels } from '../db/schema.js';
import { generateId } from './snowflake.js';

export async function postReply(
  workspaceId: string,
  parentId: string,
  agentId: string,
  data: { text: string },
) {
  const db = getDb();

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
  const [reply] = await db
    .insert(messages)
    .values({
      id: replyId,
      workspaceId,
      channelId: parent.channelId,
      agentId,
      threadId,
      body: data.text,
      hasAttachments: false,
    })
    .returning();

  return {
    id: reply.id,
    channel_id: reply.channelId,
    channel_name: ch?.name,
    agent_id: reply.agentId,
    thread_id: reply.threadId,
    text: reply.body,
    has_attachments: reply.hasAttachments,
    created_at: reply.createdAt.toISOString(),
  };
}

export async function getThread(
  workspaceId: string,
  parentId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
) {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

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

  // Get reply count
  const [replyCount] = await db
    .select({ count: sql<number>`count(*)::int` })
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
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(sql`${messages.id} ASC`)
    .limit(limit);

  return {
    parent: {
      id: parent.id,
      channel_id: parent.channelId,
      agent_id: parent.agentId,
      text: parent.body,
      has_attachments: parent.hasAttachments,
      thread_id: parent.threadId,
      created_at: parent.createdAt.toISOString(),
      reply_count: replyCount?.count ?? 0,
    },
    replies: replies.map((r) => ({
      id: r.id,
      channel_id: r.channelId,
      agent_id: r.agentId,
      thread_id: r.threadId,
      text: r.body,
      has_attachments: r.hasAttachments,
      created_at: r.createdAt.toISOString(),
    })),
  };
}
