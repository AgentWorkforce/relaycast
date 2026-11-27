import { prepareAuthorityFanout } from './deliveryWrites.js';
import { parseMessageMentions } from './mentions.js';
import { eq, and, sql, isNull, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, agents, reactions, readReceipts, messageAttachments } from '../db/tables.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import * as sqlx from '../db/sqlx.js';
import { generateId } from './snowflake.js';
import { newestSnowflakePage } from './snowflakePage.js';
import { buildMessageLogWrite } from './console.js';
import {
  buildChannelDeliveryWrite,
  fetchChannelDeliveryOutcomes,
  type DeliveryOutcomeRecords,
} from './deliveryWrites.js';
import { senderFields, senderStampMetadata } from './address.js';
import type { AgentDeviceStamp } from '../ports/auth.js';
import { displayAgentName, publicMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';
import { DEFAULT_MAILBOX_DEPTH_CAP, DEFAULT_MAILBOX_TTL_MS, DEFAULT_OFFLINE_FANOUT_EXCLUDE_MS, type MailboxConfig } from './mailboxConfig.js';
import type { WorkspaceDeliveryPolicy } from './workspaceDeliveryPolicy.js';
import { fetchAttachmentsBatch, resolveSendAttachments, type AttachmentRow } from './attachments.js';
import { buildMessageSessionWrite, requireSessionRefFromMetadata } from './sessionMessages.js';
import { ownerApprovalFlag, type OwnerApproval } from './ownerApproval.js';

type Db = ReturnType<typeof getDb>;

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
    /** Validated by the route; stored in its own immutable column. */
    owner_approval?: OwnerApproval | null;
  },
  options: { mailbox?: MailboxConfig; workspaceDeliveryPolicy?: WorkspaceDeliveryPolicy; senderDevice?: AgentDeviceStamp | null } = {},
) {
  const startedAtMs = Date.now();
  const messageId = generateId();

  const mentionedHandles = new Set(parseMessageMentions(data.text));

  const createdAt = new Date();

  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
    offlineExcludeMs: DEFAULT_OFFLINE_FANOUT_EXCLUDE_MS,
  };

  const [attachments, [agent]] = await Promise.all([
    resolveSendAttachments(db, workspaceId, data.attachments),
    db.select({ name: agents.name, type: agents.type }).from(agents).where(eq(agents.id, agentId)),
  ]);
  // Channel posts carry no sender address; a person's device stamp goes after
  // the caller's sanitized metadata.
  const metadata = {
    ...sanitizeUserMessageMetadata(data.data),
    ...(agent ? senderStampMetadata({ ...agent, node: null }, options.senderDevice, { withAddress: false }) : {}),
  };
  const sessionRef = requireSessionRefFromMetadata(metadata);
  const hasAttachments = attachments.length > 0;

  // Durable writes run as one atomic unit when the adapter supports it; fanout
  // stays in routes. Delivery recipients are derived by the delivery insert
  // itself, so membership changes cannot slip in between a pre-read and commit.
  const authorityLeases = await prepareAuthorityFanout(db, workspaceId, { channelId });
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
          sessionRef,
          hasAttachments,
          ownerApproval: data.owner_approval ?? null,
          createdAt,
        })
        .returning(),
    ];

    const sessionWrite = buildMessageSessionWrite(
      writeDb,
      workspaceId,
      sessionRef,
      createdAt,
    );
    if (sessionWrite) writes.push(sessionWrite);

    if (attachments.length > 0) {
      const attachmentValues = attachments.map((attachment, idx) => ({
        messageId,
        fileId: attachment.file_id,
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
        ttlMs: mailbox.ttlMs,
        depthCap: mailbox.depthCap,
        offlineExcludeMs: mailbox.offlineExcludeMs,
        authorityLeases,
        mentionHandles: Array.from(mentionedHandles),
        workspacePolicy: options.workspaceDeliveryPolicy,
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
        // Console logs keep the caller's metadata only: no __relaycast_ key is served.
        metadata: {
          ...sanitizeUserMessageMetadata(data.data),
          injection_mode: data.mode ?? 'wait',
        },
        attachmentCount: attachments.length,
        mentionCount: mentionedHandles.size,
        latencyMs: Date.now() - startedAtMs,
      }),
    );

    return writes;
  }, { requireAtomic: Boolean(options.workspaceDeliveryPolicy) });
  const [message] = results[0] as (typeof messages.$inferSelect)[];
  const deliveryOutcomes: DeliveryOutcomeRecords = await fetchChannelDeliveryOutcomes(db, {
    messageId,
    channelId,
    senderAgentId: agentId,
    mentionHandles: Array.from(mentionedHandles),
    offlineExcludeMs: mailbox.offlineExcludeMs,
        authorityLeases,
  });

  return {
    id: message.id,
    channel_id: message.channelId,
    agent_id: message.agentId,
    agent_name: agent?.name || 'unknown',
    ...senderFields(message.metadata),
    text: message.body,
    blocks: (message.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(message.metadata),
    has_attachments: message.hasAttachments,
    thread_id: message.threadId,
    reply_to_message_id: message.replyToMessageId,
    created_at: message.createdAt.toISOString(),
    mentions: Array.from(mentionedHandles),
    attachments,
    injection_mode: data.mode ?? 'wait',
    ...ownerApprovalFlag(message.ownerApproval),
    _deliveries: deliveryOutcomes.deliveries,
    _delivery_rejections: deliveryOutcomes.rejections,
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

  // Snowflake ids are variable-width decimal TEXT: page numerically. Pin the
  // channel index so SQLite cannot pick the workspace index and sort the whole
  // workspace history.
  const rows = await newestSnowflakePage(db, messages.id, { ...opts, limit }, (cursor, orderBy, pageLimit) =>
    db
      .select({
        id: sql`${messages.id}`.mapWith(messages.id),
        workspaceId: sql`${messages.workspaceId}`.mapWith(messages.workspaceId),
        channelId: sql`${messages.channelId}`.mapWith(messages.channelId),
        agentId: sql`${messages.agentId}`.mapWith(messages.agentId),
        agentName: agents.name,
        threadId: sql`${messages.threadId}`.mapWith(messages.threadId),
        replyToMessageId: sql`${messages.replyToMessageId}`.mapWith(messages.replyToMessageId),
        body: sql`${messages.body}`.mapWith(messages.body),
        blocks: sql`${messages.blocks}`.mapWith(messages.blocks),
        metadata: sql`${messages.metadata}`.mapWith(messages.metadata),
        hasAttachments: sql`${messages.hasAttachments}`.mapWith(messages.hasAttachments),
        createdAt: sql`${messages.createdAt}`.mapWith(messages.createdAt),
        updatedAt: sql`${messages.updatedAt}`.mapWith(messages.updatedAt),
      })
      .from(sql`${messages} ${sqlx.indexedBy(db, 'idx_messages_channel_length_id')}`)
      .leftJoin(agents, eq(messages.agentId, agents.id))
      .where(and(...conditions, cursor))
      .orderBy(orderBy)
      .limit(pageLimit));

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
  const attachmentMap = await fetchAttachmentsBatch(db, workspaceId, attachmentMsgIds);

  return rows.map((row) => ({
    id: row.id,
    channel_id: row.channelId,
    agent_id: row.agentId,
    agent_name: displayAgentName(row.metadata, row.agentName),
    ...senderFields(row.metadata),
    text: row.body,
    blocks: (row.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(row.metadata),
    has_attachments: row.hasAttachments,
    thread_id: row.threadId,
    reply_to_message_id: row.replyToMessageId,
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
      replyToMessageId: messages.replyToMessageId,
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
    row.hasAttachments ? fetchAttachmentsBatch(db, workspaceId, [row.id]) : Promise.resolve(new Map<string, AttachmentRow[]>()),
  ]);

  return {
    id: row.id,
    channel_id: row.channelId,
    agent_id: row.agentId,
    agent_name: displayAgentName(row.metadata, row.agentName),
    ...senderFields(row.metadata),
    text: row.body,
    blocks: (row.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(row.metadata),
    has_attachments: row.hasAttachments,
    thread_id: row.threadId,
    reply_to_message_id: row.replyToMessageId,
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
