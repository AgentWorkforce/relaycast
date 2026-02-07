import { eq, and, sql, isNull, lt, gt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { messages, channels, agents, reactions, readReceipts } from '../db/schema.js';
import { generateId } from './snowflake.js';

export async function postMessage(
  workspaceId: string,
  channelId: string,
  agentId: string,
  data: { text: string; attachments?: string[]; data?: Record<string, unknown> | null; content_type?: string },
) {
  const db = getDb();
  const messageId = generateId();

  // Parse @mentions from text
  const mentionPattern = /@(\w+)/g;
  const mentionMatches = data.text.match(mentionPattern) || [];

  const hasAttachments = !!(data.attachments && data.attachments.length > 0);

  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId,
      channelId,
      agentId,
      body: data.text,
      hasAttachments,
    })
    .returning();

  return {
    id: message.id,
    channel_id: message.channelId,
    agent_id: message.agentId,
    text: message.body,
    has_attachments: message.hasAttachments,
    thread_id: message.threadId,
    created_at: message.createdAt.toISOString(),
    mentions: mentionMatches.map((m: string) => m.slice(1)),
  };
}

export async function getMessages(
  workspaceId: string,
  channelId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
) {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

  const conditions = [
    eq(messages.channelId, channelId),
    eq(messages.workspaceId, workspaceId),
    isNull(messages.threadId),
  ];

  if (opts.before) {
    conditions.push(lt(messages.id, opts.before));
  }
  if (opts.after) {
    conditions.push(gt(messages.id, opts.after));
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(sql`${messages.id} DESC`)
    .limit(limit);

  // Batch enrichment
  const enriched = [];
  for (const row of rows) {
    // reply count
    const [replyCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.threadId, row.id));

    // reaction groups
    const reactionRows = await db
      .select({
        emoji: reactions.emoji,
        count: sql<number>`count(*)::int`,
      })
      .from(reactions)
      .where(eq(reactions.messageId, row.id))
      .groupBy(reactions.emoji);

    // read_by_count
    const [readCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(readReceipts)
      .where(eq(readReceipts.messageId, row.id));

    enriched.push({
      id: row.id,
      channel_id: row.channelId,
      agent_id: row.agentId,
      text: row.body,
      has_attachments: row.hasAttachments,
      thread_id: row.threadId,
      created_at: row.createdAt.toISOString(),
      reply_count: replyCount?.count ?? 0,
      reactions: reactionRows.map((r) => ({ emoji: r.emoji, count: r.count })),
      read_by_count: readCount?.count ?? 0,
    });
  }

  return enriched;
}

export async function getMessage(workspaceId: string, messageId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));

  if (!row) return null;

  // reply count
  const [replyCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.threadId, row.id));

  // reaction groups
  const reactionRows = await db
    .select({
      emoji: reactions.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(reactions)
    .where(eq(reactions.messageId, row.id))
    .groupBy(reactions.emoji);

  // read_by_count
  const [readCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(readReceipts)
    .where(eq(readReceipts.messageId, row.id));

  return {
    id: row.id,
    channel_id: row.channelId,
    agent_id: row.agentId,
    text: row.body,
    has_attachments: row.hasAttachments,
    thread_id: row.threadId,
    created_at: row.createdAt.toISOString(),
    reply_count: replyCount?.count ?? 0,
    reactions: reactionRows.map((r) => ({ emoji: r.emoji, count: r.count })),
    read_by_count: readCount?.count ?? 0,
  };
}

