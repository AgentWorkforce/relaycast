import { eq, and, sql, isNull, lt, gt, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, reactions, readReceipts, messageAttachments, files } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

type AttachmentRow = { file_id: string; filename: string; content_type: string; size_bytes: number };

async function fetchAttachmentsBatch(db: Db, msgIds: string[]): Promise<Map<string, AttachmentRow[]>> {
  const map = new Map<string, AttachmentRow[]>();
  if (msgIds.length === 0) return map;

  const rows = await db
    .select({
      messageId: messageAttachments.messageId,
      fileId: messageAttachments.fileId,
      filename: files.filename,
      contentType: files.contentType,
      sizeBytes: files.sizeBytes,
    })
    .from(messageAttachments)
    .innerJoin(files, eq(messageAttachments.fileId, files.id))
    .where(inArray(messageAttachments.messageId, msgIds));

  for (const row of rows) {
    const list = map.get(row.messageId) || [];
    list.push({
      file_id: row.fileId,
      filename: row.filename,
      content_type: row.contentType,
      size_bytes: row.sizeBytes,
    });
    map.set(row.messageId, list);
  }
  return map;
}

export async function postMessage(
  db: Db,
  workspaceId: string,
  channelId: string,
  agentId: string,
  data: { text: string; blocks?: unknown[] | null; attachments?: string[]; data?: Record<string, unknown> | null; content_type?: string },
) {
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
      blocks: data.blocks || null,
      hasAttachments,
    })
    .returning();

  // Insert attachment records into junction table
  if (data.attachments && data.attachments.length > 0) {
    const attachmentValues = data.attachments.map((fileId, idx) => ({
      messageId,
      fileId,
      position: idx,
    }));
    await db.insert(messageAttachments).values(attachmentValues);
  }

  // Fetch attachment details if any
  const attachmentMap = hasAttachments ? await fetchAttachmentsBatch(db, [messageId]) : new Map();
  const attachments = attachmentMap.get(messageId) || [];

  return {
    id: message.id,
    channel_id: message.channelId,
    agent_id: message.agentId,
    text: message.body,
    blocks: (message.blocks as unknown[] | null) || null,
    has_attachments: message.hasAttachments,
    thread_id: message.threadId,
    created_at: message.createdAt.toISOString(),
    mentions: mentionMatches.map((m: string) => m.slice(1)),
    attachments,
  };
}

export async function getMessages(
  db: Db,
  workspaceId: string,
  channelId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
) {
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

  if (rows.length === 0) return [];

  const msgIds = rows.map((r) => r.id);

  // Batch: reply counts (single query for all messages)
  const replyCounts = await db
    .select({
      threadId: messages.threadId,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(inArray(messages.threadId, msgIds))
    .groupBy(messages.threadId);

  const replyCountMap = new Map<string, number>();
  for (const r of replyCounts) {
    if (r.threadId) replyCountMap.set(r.threadId, r.count);
  }

  // Batch: reaction groups (single query for all messages)
  const reactionRows = await db
    .select({
      messageId: reactions.messageId,
      emoji: reactions.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(reactions)
    .where(inArray(reactions.messageId, msgIds))
    .groupBy(reactions.messageId, reactions.emoji);

  const reactionMap = new Map<string, Array<{ emoji: string; count: number }>>();
  for (const r of reactionRows) {
    const list = reactionMap.get(r.messageId) || [];
    list.push({ emoji: r.emoji, count: r.count });
    reactionMap.set(r.messageId, list);
  }

  // Batch: read receipt counts (single query for all messages)
  const readCounts = await db
    .select({
      messageId: readReceipts.messageId,
      count: sql<number>`count(*)::int`,
    })
    .from(readReceipts)
    .where(inArray(readReceipts.messageId, msgIds))
    .groupBy(readReceipts.messageId);

  const readCountMap = new Map<string, number>();
  for (const r of readCounts) {
    readCountMap.set(r.messageId, r.count);
  }

  // Batch: attachments (single query for all messages with attachments)
  const attachmentMsgIds = rows.filter((r) => r.hasAttachments).map((r) => r.id);
  const attachmentMap = await fetchAttachmentsBatch(db, attachmentMsgIds);

  return rows.map((row) => ({
    id: row.id,
    channel_id: row.channelId,
    agent_id: row.agentId,
    text: row.body,
    blocks: (row.blocks as unknown[] | null) || null,
    has_attachments: row.hasAttachments,
    thread_id: row.threadId,
    created_at: row.createdAt.toISOString(),
    reply_count: replyCountMap.get(row.id) ?? 0,
    reactions: reactionMap.get(row.id) || [],
    read_by_count: readCountMap.get(row.id) ?? 0,
    attachments: attachmentMap.get(row.id) || [],
  }));
}

export async function getMessage(db: Db, workspaceId: string, messageId: string) {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));

  if (!row) return null;

  // Parallel enrichment queries for single message
  const [replyCounts, reactionRows, readCounts, attachmentMap] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.threadId, row.id)),
    db
      .select({
        emoji: reactions.emoji,
        count: sql<number>`count(*)::int`,
      })
      .from(reactions)
      .where(eq(reactions.messageId, row.id))
      .groupBy(reactions.emoji),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(readReceipts)
      .where(eq(readReceipts.messageId, row.id)),
    row.hasAttachments ? fetchAttachmentsBatch(db, [row.id]) : Promise.resolve(new Map<string, AttachmentRow[]>()),
  ]);

  return {
    id: row.id,
    channel_id: row.channelId,
    agent_id: row.agentId,
    text: row.body,
    blocks: (row.blocks as unknown[] | null) || null,
    has_attachments: row.hasAttachments,
    thread_id: row.threadId,
    created_at: row.createdAt.toISOString(),
    reply_count: replyCounts[0]?.count ?? 0,
    reactions: reactionRows.map((r) => ({ emoji: r.emoji, count: r.count })),
    read_by_count: readCounts[0]?.count ?? 0,
    attachments: attachmentMap.get(row.id) || [],
  };
}
