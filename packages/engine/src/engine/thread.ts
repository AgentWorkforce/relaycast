import { prepareAuthorityFanout } from './deliveryWrites.js';
import { eq, and, sql, lt, gt } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, dmConversations, nodes } from '../db/schema.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { generateId } from './snowflake.js';
import {
  buildChannelDeliveryWrite,
  buildGroupDmDeliveryWrite,
  fetchChannelDeliveryOutcomes,
  fetchGroupDeliveryOutcomes,
  type DeliveryOutcomeRecords,
} from './deliveryWrites.js';
import { displayAgentName, publicMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';
import { DEFAULT_MAILBOX_DEPTH_CAP, DEFAULT_MAILBOX_TTL_MS, DEFAULT_OFFLINE_FANOUT_EXCLUDE_MS, type MailboxConfig } from './mailboxConfig.js';
import type { WorkspaceDeliveryPolicy } from './workspaceDeliveryPolicy.js';
import { codedError } from '../lib/httpError.js';
import { buildMessageSessionWrite, requireSessionRefFromMetadata } from './sessionMessages.js';
import {
  addressNodeSelection,
  formatAgentAddress,
  SENDER_ADDRESS_METADATA_KEY,
  senderAddressField,
} from './address.js';

type Db = ReturnType<typeof getDb>;

export async function postReply(
  db: Db,
  workspaceId: string,
  parentId: string,
  agentId: string,
  data: { text: string; blocks?: unknown[] | null; data?: Record<string, unknown> | null },
  options: { mailbox?: MailboxConfig; workspaceDeliveryPolicy?: WorkspaceDeliveryPolicy } = {},
) {
  // Get the parent message
  const [parent] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, parentId), eq(messages.workspaceId, workspaceId)));

  if (!parent) {
    throw codedError('Parent message not found', 'message_not_found', 404);
  }

  // If parent itself has a thread_id, resolve to root (reply-to-reply goes to original parent)
  const threadId = parent.threadId || parent.id;

  const [ch] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, parent.channelId));
  const [dmConversation] = await db
    .select({ id: dmConversations.id, dmType: dmConversations.dmType })
    .from(dmConversations)
    .where(eq(dmConversations.channelId, parent.channelId));

  const [agent] = await db
    .select({ name: agents.name, node: addressNodeSelection })
    .from(agents)
    .leftJoin(nodes, eq(nodes.id, agents.locationNodeId))
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));
  const senderAddress = agent?.name ? formatAgentAddress(agent.name, agent.node) : null;

  const replyId = generateId();
  const metadata = {
    ...sanitizeUserMessageMetadata(data.data),
    ...(senderAddress ? { [SENDER_ADDRESS_METADATA_KEY]: senderAddress } : {}),
  };
  const sessionRef = requireSessionRefFromMetadata(metadata);
  const createdAt = new Date();
  const mentionPattern = /(?:^|\s)@([\w-]+)/g;
  const mentionedHandles = new Set<string>();
  for (let match = mentionPattern.exec(data.text); match !== null; match = mentionPattern.exec(data.text)) {
    mentionedHandles.add(match[1]);
  }
  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
    offlineExcludeMs: DEFAULT_OFFLINE_FANOUT_EXCLUDE_MS,
  };

  // Durable writes run as one atomic unit when the adapter supports it; fanout
  // stays in routes. Delivery recipients are derived by the insert-select
  // against current channel membership.
  const authorityLeases = await prepareAuthorityFanout(db, workspaceId, dmConversation
    ? { conversationId: dmConversation.id }
    : { channelId: parent.channelId });
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [
      writeDb
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
          sessionRef,
          hasAttachments: false,
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

    writes.push(
      dmConversation
        ? buildGroupDmDeliveryWrite(writeDb, {
          workspaceId,
          messageId: replyId,
          conversationId: dmConversation.id,
          senderAgentId: agentId,
          mode: 'immediate',
          ttlMs: mailbox.ttlMs,
          depthCap: mailbox.depthCap,
          offlineExcludeMs: mailbox.offlineExcludeMs,
        authorityLeases,
          excludeLongOffline: dmConversation.dmType !== '1:1',
          workspacePolicy: options.workspaceDeliveryPolicy,
        })
        : buildChannelDeliveryWrite(writeDb, {
          workspaceId,
          messageId: replyId,
          channelId: parent.channelId,
          senderAgentId: agentId,
          mode: 'immediate',
          ttlMs: mailbox.ttlMs,
          depthCap: mailbox.depthCap,
          offlineExcludeMs: mailbox.offlineExcludeMs,
        authorityLeases,
          reason: 'thread-reply',
          mentionHandles: Array.from(mentionedHandles),
          workspacePolicy: options.workspaceDeliveryPolicy,
        }),
    );

    return writes;
  }, { requireAtomic: Boolean(options.workspaceDeliveryPolicy) });
  const [reply] = results[0] as (typeof messages.$inferSelect)[];
  const deliveryOutcomes: DeliveryOutcomeRecords = dmConversation
    ? await fetchGroupDeliveryOutcomes(db, {
      messageId: replyId,
      conversationId: dmConversation.id,
      senderAgentId: agentId,
      offlineExcludeMs: mailbox.offlineExcludeMs,
        authorityLeases,
      excludeLongOffline: dmConversation.dmType !== '1:1',
    })
    : await fetchChannelDeliveryOutcomes(db, {
      messageId: replyId,
      channelId: parent.channelId,
      senderAgentId: agentId,
      mentionHandles: Array.from(mentionedHandles),
      offlineExcludeMs: mailbox.offlineExcludeMs,
        authorityLeases,
    });

  return {
    id: reply.id,
    channel_id: reply.channelId,
    channel_name: ch?.name,
    ...(dmConversation ? { conversation_id: dmConversation.id } : {}),
    agent_id: reply.agentId,
    agent_name: agent?.name || 'unknown',
    ...senderAddressField(reply.metadata),
    thread_id: reply.threadId,
    text: reply.body,
    blocks: (reply.blocks as unknown[] | null) || null,
    metadata: publicMessageMetadata(reply.metadata),
    has_attachments: reply.hasAttachments,
    created_at: reply.createdAt.toISOString(),
    // Internal: delivery records for recipients — stripped by route before response
    _deliveries: deliveryOutcomes.deliveries,
    _delivery_rejections: deliveryOutcomes.rejections,
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
    throw codedError('Parent message not found', 'message_not_found', 404);
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
      id: sql`${messages.id}`.mapWith(messages.id),
      channelId: sql`${messages.channelId}`.mapWith(messages.channelId),
      agentId: sql`${messages.agentId}`.mapWith(messages.agentId),
      agentName: agents.name,
      threadId: sql`${messages.threadId}`.mapWith(messages.threadId),
      body: sql`${messages.body}`.mapWith(messages.body),
      blocks: sql`${messages.blocks}`.mapWith(messages.blocks),
      metadata: sql`${messages.metadata}`.mapWith(messages.metadata),
      hasAttachments: sql`${messages.hasAttachments}`.mapWith(messages.hasAttachments),
      createdAt: sql`${messages.createdAt}`.mapWith(messages.createdAt),
    })
    // SQLite can otherwise prefer the workspace/id index and scan unrelated
    // history. This existing index seeks the thread and supports id pagination.
    .from(sql`${messages} INDEXED BY idx_messages_thread`)
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
      ...senderAddressField(parent.metadata),
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
      ...senderAddressField(r.metadata),
      thread_id: r.threadId,
      text: r.body,
      blocks: (r.blocks as unknown[] | null) || null,
      metadata: publicMessageMetadata(r.metadata),
      has_attachments: r.hasAttachments,
      created_at: r.createdAt.toISOString(),
    })),
  };
}
