import { eq, and, sql, isNull, lt, gt, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, agents, reactions, readReceipts, messageAttachments, files } from '../db/schema.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { generateId } from './snowflake.js';
import { buildMessageLogWrite } from './console.js';
import {
  buildChannelDeliveryWrite,
  fetchDeliveryFanoutRecords,
} from './deliveryWrites.js';
import { displayAgentName, publicMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';

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

/**
 * Fetch attachment details straight from `files` by id, preserving the
 * caller's ordering. Used by the send path, which needs the details *before*
 * the `message_attachments` rows exist — the junction insert is part of the
 * atomic write batch, so it cannot be joined against mid-send.
 */
async function fetchAttachmentDetails(db: Db, fileIds: string[]): Promise<AttachmentRow[]> {
  if (fileIds.length === 0) return [];

  const rows = await db
    .select({
      fileId: files.id,
      filename: files.filename,
      contentType: files.contentType,
      sizeBytes: files.sizeBytes,
    })
    .from(files)
    .where(inArray(files.id, fileIds));

  const byId = new Map(rows.map((row) => [row.fileId, row]));
  return fileIds
    .filter((id) => byId.has(id))
    .map((id) => {
      const row = byId.get(id)!;
      return {
        file_id: row.fileId,
        filename: row.filename,
        content_type: row.contentType,
        size_bytes: row.sizeBytes,
      };
    });
}

export async function postMessage(
  db: Db,
  workspaceId: string,
  channelId: string,
  agentId: string,
  data: {
    text: string;
    blocks?: unknown[] | null;
    attachments?: string[];
    data?: Record<string, unknown> | null;
    content_type?: string;
    mode?: 'wait' | 'steer';
  },
) {
  const startedAtMs = Date.now();
  const messageId = generateId();

  // Parse @mentions from text
  const mentionPattern = /@(\w+)/g;
  const mentionMatches = data.text.match(mentionPattern) || [];

  const hasAttachments = !!(data.attachments && data.attachments.length > 0);
  const metadata = sanitizeUserMessageMetadata(data.data);

  const mentionedHandles = new Set(mentionMatches.map((m: string) => m.slice(1)));

  const [attachments, [agent]] = await Promise.all([
    fetchAttachmentDetails(db, data.attachments ?? []),
    db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)),
  ]);

  // Durable writes run as one atomic unit when the adapter supports it; fanout
  // stays in routes. Delivery recipients are derived by the delivery insert
  // itself, so membership changes cannot slip in between a pre-read and commit.
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [
      writeDb
        .insert(messages)
        .values({
          id: messageId,
          workspaceId,
          channelId,
          agentId,
          body: data.text,
          blocks: data.blocks || null,
          metadata,
          hasAttachments,
        })
        .returning(),
    ];

    if (data.attachments && data.attachments.length > 0) {
      const attachmentValues = data.attachments.map((fileId, idx) => ({
        messageId,
        fileId,
        position: idx,
      }));
      writes.push(writeDb.insert(messageAttachments).values(attachmentValues));
    }

    writes.push(
      buildChannelDeliveryWrite(writeDb, {
        workspaceId,
        messageId,
        channelId,
        senderAgentId: agentId,
        mode: data.mode === 'steer' ? 'next-tool-call' : 'immediate',
        mentionHandles: Array.from(mentionedHandles),
      }),
    );

    writes.push(
      buildMessageLogWrite(writeDb, {
        workspaceId,
        messageId,
        channelId,
        agentId,
        deliveryKind: 'channel',
        body: data.text,
        contentType: data.content_type ?? null,
        metadata: {
          ...metadata,
          injection_mode: data.mode ?? 'wait',
        },
        attachmentCount: attachments.length,
        mentionCount: mentionMatches.length,
        latencyMs: Date.now() - startedAtMs,
      }),
    );

    return writes;
  });
  const [message] = results[0] as (typeof messages.$inferSelect)[];
  const deliveryRecords = await fetchDeliveryFanoutRecords(db, messageId);

  return {
    id: message.id,
    channel_id: message.channelId,
    agent_id: message.agentId,
    agent_name: agent?.name || 'unknown',
    text: message.body,
    blocks: (message.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(message.metadata),
    has_attachments: message.hasAttachments,
    thread_id: message.threadId,
    created_at: message.createdAt.toISOString(),
    mentions: mentionMatches.map((m: string) => m.slice(1)),
    attachments,
    injection_mode: data.mode ?? 'wait',
    _deliveries: deliveryRecords,
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
    .select({
      id: messages.id,
      workspaceId: messages.workspaceId,
      channelId: messages.channelId,
      agentId: messages.agentId,
      agentName: agents.name,
      threadId: messages.threadId,
      body: messages.body,
      blocks: messages.blocks,
      metadata: messages.metadata,
      hasAttachments: messages.hasAttachments,
      createdAt: messages.createdAt,
      updatedAt: messages.updatedAt,
    })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(sql`${messages.id} DESC`)
    .limit(limit);

  if (rows.length === 0) return [];

  const msgIds = rows.map((r) => r.id);

  // Batch: reply counts (single query for all messages)
  const replyCounts = await db
    .select({
      threadId: messages.threadId,
      count: sql<number>`count(*)`,
    })
    .from(messages)
    .where(inArray(messages.threadId, msgIds))
    .groupBy(messages.threadId);

  const replyCountMap = new Map<string, number>();
  for (const r of replyCounts) {
    if (r.threadId) replyCountMap.set(r.threadId, r.count);
  }

  // Batch: reaction rows with agent names (single query for all messages)
  const reactionRows = await db
    .select({
      messageId: reactions.messageId,
      emoji: reactions.emoji,
      agentName: agents.name,
    })
    .from(reactions)
    .innerJoin(agents, eq(reactions.agentId, agents.id))
    .where(inArray(reactions.messageId, msgIds));

  const reactionMap = new Map<string, Array<{ emoji: string; count: number; agents: string[] }>>();
  for (const r of reactionRows) {
    const list = reactionMap.get(r.messageId) || [];
    const existing = list.find((e) => e.emoji === r.emoji);
    if (existing) {
      existing.count++;
      existing.agents.push(r.agentName);
    } else {
      list.push({ emoji: r.emoji, count: 1, agents: [r.agentName] });
    }
    reactionMap.set(r.messageId, list);
  }

  // Batch: read receipt counts (single query for all messages)
  const readCounts = await db
    .select({
      messageId: readReceipts.messageId,
      count: sql<number>`count(*)`,
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
    agent_name: displayAgentName(row.metadata, row.agentName),
    text: row.body,
    blocks: (row.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(row.metadata),
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
    .select({
      id: messages.id,
      workspaceId: messages.workspaceId,
      channelId: messages.channelId,
      agentId: messages.agentId,
      agentName: agents.name,
      threadId: messages.threadId,
      body: messages.body,
      blocks: messages.blocks,
      metadata: messages.metadata,
      hasAttachments: messages.hasAttachments,
      createdAt: messages.createdAt,
      updatedAt: messages.updatedAt,
    })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));

  if (!row) return null;

  // Parallel enrichment queries for single message
  const [replyCounts, reactionRows, readCounts, attachmentMap] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.threadId, row.id)),
    db
      .select({
        emoji: reactions.emoji,
        agentName: agents.name,
      })
      .from(reactions)
      .innerJoin(agents, eq(reactions.agentId, agents.id))
      .where(eq(reactions.messageId, row.id)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(readReceipts)
      .where(eq(readReceipts.messageId, row.id)),
    row.hasAttachments ? fetchAttachmentsBatch(db, [row.id]) : Promise.resolve(new Map<string, AttachmentRow[]>()),
  ]);

  return {
    id: row.id,
    channel_id: row.channelId,
    agent_id: row.agentId,
    agent_name: displayAgentName(row.metadata, row.agentName),
    text: row.body,
    blocks: (row.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(row.metadata),
    has_attachments: row.hasAttachments,
    thread_id: row.threadId,
    created_at: row.createdAt.toISOString(),
    reply_count: replyCounts[0]?.count ?? 0,
    reactions: Object.values(reactionRows.reduce<Record<string, { emoji: string; count: number; agents: string[] }>>((acc, r) => {
      if (!acc[r.emoji]) acc[r.emoji] = { emoji: r.emoji, count: 0, agents: [] };
      acc[r.emoji].count++;
      acc[r.emoji].agents.push(r.agentName);
      return acc;
    }, {})),
    read_by_count: readCounts[0]?.count ?? 0,
    attachments: attachmentMap.get(row.id) || [],
  };
}
