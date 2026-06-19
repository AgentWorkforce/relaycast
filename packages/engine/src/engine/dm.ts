import { eq, and, sql, lt, gt, isNull, inArray } from 'drizzle-orm';
import type { DmMessage } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import {
  messages,
  channels,
  agents,
  dmConversations,
  dmParticipants,
  messageAttachments,
  files,
} from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { generateId } from './snowflake.js';
import * as a2aEngine from './a2a.js';
import { buildMessageLogWrite } from './console.js';
import {
  buildDirectDeliveryWrite,
  fetchDirectDeliveryOutcomes,
  type DeliveryOutcomeRecords,
} from './deliveryWrites.js';
import { DEFAULT_MAILBOX_DEPTH_CAP, DEFAULT_MAILBOX_TTL_MS, type MailboxConfig } from './mailboxConfig.js';
import { codedError } from '../lib/httpError.js';
import { fetchAttachmentsBatch, type AttachmentRow } from './attachments.js';

type Db = ReturnType<typeof getDb>;

interface SendDmOptions {
  skipA2aIntercept?: boolean;
  mailbox?: MailboxConfig;
}

async function getDmPairKey(workspaceId: string, agentA: string, agentB: string): Promise<string> {
  const [first, second] = [agentA, agentB].sort();
  return (await sha256Hex(`${workspaceId}:${first}:${second}`)).slice(0, 24);
}

async function resolveConversation(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  toAgentId: string,
) {
  const existing = await db.all<{ id: string; channel_id: string }>(sql`
    SELECT dc.id, dc.channel_id
    FROM dm_conversations dc
    JOIN dm_participants p1
      ON p1.conversation_id = dc.id
     AND p1.agent_id = ${fromAgentId}
     AND p1.left_at IS NULL
    JOIN dm_participants p2
      ON p2.conversation_id = dc.id
     AND p2.agent_id = ${toAgentId}
     AND p2.left_at IS NULL
    WHERE dc.workspace_id = ${workspaceId}
      AND dc.dm_type = '1:1'
    LIMIT 1
  `);

  let conversationId = existing[0]?.id;

  if (!conversationId) {
    const pairKey = await getDmPairKey(workspaceId, fromAgentId, toAgentId);
    const deterministicConversationId = `dm_${pairKey}`;
    const deterministicChannelId = `dmch_${pairKey}`;

    await db.insert(channels).values({
      id: deterministicChannelId,
      workspaceId,
      name: `dm-${pairKey}`,
      channelType: 1,
    }).onConflictDoNothing();

    await db.insert(dmConversations).values({
      id: deterministicConversationId,
      workspaceId,
      channelId: deterministicChannelId,
      dmType: '1:1',
    }).onConflictDoNothing();

    await db.insert(dmParticipants).values({
      conversationId: deterministicConversationId,
      agentId: fromAgentId,
    }).onConflictDoNothing();
    await db.insert(dmParticipants).values({
      conversationId: deterministicConversationId,
      agentId: toAgentId,
    }).onConflictDoNothing();

    conversationId = deterministicConversationId;
  }

  const [conv] = await db
    .select({ id: dmConversations.id, channelId: dmConversations.channelId })
    .from(dmConversations)
    .where(
      and(
        eq(dmConversations.id, conversationId),
        eq(dmConversations.workspaceId, workspaceId),
      ),
    );

  if (!conv) {
    throw codedError('Conversation not found', 'not_found', 404);
  }

  return conv;
}

async function resolveAttachments(
  db: Db,
  workspaceId: string,
  attachmentIds?: string[],
): Promise<AttachmentRow[]> {
  if (!attachmentIds || attachmentIds.length === 0) return [];

  const unique = new Set(attachmentIds);
  if (unique.size !== attachmentIds.length) {
    throw codedError('Invalid attachments: duplicate file ids are not allowed', 'invalid_attachments', 400);
  }

  const validFiles = await db
    .select({
      file_id: files.id,
      filename: files.filename,
      content_type: files.contentType,
      size_bytes: files.sizeBytes,
    })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.status, 'complete'),
        inArray(files.id, attachmentIds),
      ),
    );

  const validIds = new Set(validFiles.map((f) => f.file_id));
  const invalid = attachmentIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    throw codedError('Invalid attachments: file ids must exist in workspace and be complete', 'invalid_attachments', 400);
  }

  const ordered = new Map(validFiles.map((file) => [file.file_id, file]));
  return attachmentIds.map((id) => ordered.get(id)!);
}

/**
 * Build the message + attachment-junction inserts for a DM without executing
 * them, so the send path can run them inside one atomic unit. The message
 * insert is always first and carries `.returning()`.
 */
function buildDmMessageWrites(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  channelId: string,
  data: { text: string; attachments?: string[]; mode?: 'wait' | 'steer' },
  messageId: string,
): AtomicWrite[] {
  const hasAttachments = !!(data.attachments && data.attachments.length > 0);
  const writes: AtomicWrite[] = [
    db
      .insert(messages)
      .values({
        id: messageId,
        workspaceId,
        channelId,
        agentId: fromAgentId,
        body: data.text,
        hasAttachments,
        metadata: { injection_mode: data.mode ?? 'wait' },
      })
      .returning(),
  ];

  if (data.attachments && data.attachments.length > 0) {
    const attachmentValues = data.attachments.map((fileId, idx) => ({
      messageId,
      fileId,
      position: idx,
    }));
    writes.push(db.insert(messageAttachments).values(attachmentValues));
  }

  return writes;
}

export async function sendDm(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  data: { to: string; text: string; attachments?: string[]; mode?: 'wait' | 'steer' },
  options: SendDmOptions = {},
) {
  const startedAtMs = Date.now();
  const [toAgent] = data.to === '@self'
    ? await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, fromAgentId)))
    : await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.to)));

  if (!toAgent) {
    throw codedError(`Agent "${data.to}" not found`, 'agent_not_found', 404);
  }

  const [fromAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, fromAgentId)));

  if (!fromAgent?.name) {
    throw codedError('Sender agent not found', 'internal_error', 500);
  }

  const conv = await resolveConversation(db, workspaceId, fromAgentId, toAgent.id);
  const attachments = await resolveAttachments(db, workspaceId, data.attachments);
  const a2aTarget = options.skipA2aIntercept
    ? null
    : await a2aEngine.getA2aAgentByRelayName(db, workspaceId, toAgent.name);

  const messageId = generateId();
  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
  };

  if (a2aTarget) {
    const payload = a2aEngine.translateRelayToA2a({
      id: messageId,
      agent_id: fromAgentId,
      agent_name: fromAgent.name,
      text: data.text,
      created_at: new Date().toISOString(),
      thread_id: conv.id,
      attachments,
    });

    payload.params = {
      ...payload.params,
      target_agent: toAgent.name,
      metadata: {
        target_agent: fromAgent.name,
        relay_conversation_id: conv.id,
      },
    };

    await a2aEngine.sendToExternalAgent(a2aTarget.external_url, payload, {
      scheme: a2aTarget.auth_scheme,
      credential: a2aTarget.auth_credential,
    });
    await a2aEngine.incrementA2aMessagesSent(db, a2aTarget.id);
  }

  const deliveryId = toAgent.id !== fromAgentId ? `del_${generateId()}` : null;

  // Durable writes (message + attachments + delivery + message_log) run as one
  // atomic unit when the adapter supports it; fanout stays in routes.
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes = buildDmMessageWrites(writeDb, workspaceId, fromAgentId, conv.channelId, data, messageId);

    if (deliveryId) {
      writes.push(
        buildDirectDeliveryWrite(writeDb, {
          deliveryId,
          workspaceId,
          messageId,
          agentId: toAgent.id,
          mode: data.mode === 'steer' ? 'next-tool-call' : 'immediate',
          reason: 'dm',
          ttlMs: mailbox.ttlMs,
          depthCap: mailbox.depthCap,
        }),
      );
    }

    writes.push(
      buildMessageLogWrite(writeDb, {
        workspaceId,
        messageId,
        channelId: conv.channelId,
        agentId: fromAgentId,
        conversationId: conv.id,
        deliveryKind: 'dm',
        body: data.text,
        contentType: 'text/plain',
        metadata: {
          target_agent: toAgent.name,
          injection_mode: data.mode ?? 'wait',
          ...(a2aTarget ? { a2a_target_url: a2aTarget.external_url } : {}),
        },
        attachmentCount: attachments.length,
        mentionCount: 0,
        latencyMs: Date.now() - startedAtMs,
      }),
    );

    return writes;
  });
  const [message] = results[0] as (typeof messages.$inferSelect)[];
  const deliveryOutcomes: DeliveryOutcomeRecords = deliveryId
    ? await fetchDirectDeliveryOutcomes(db, { messageId, recipientAgentId: toAgent.id })
    : { deliveries: [], rejections: [] };
  const dmDelivery = deliveryOutcomes.deliveries[0] ?? null;

  const injectionMode = data.mode ?? 'wait';
  return {
    // Canonical converged shape (new)
    conversation_id: conv.id,
    message: {
      id: message.id,
      agent_id: message.agentId,
      agent_name: fromAgent.name,
      text: message.body,
      injection_mode: injectionMode,
      attachments,
    },
    created_at: message.createdAt.toISOString(),

    // Legacy compatibility fields (scheduled for removal in next major).
    id: message.id,
    from_agent_id: message.agentId,
    to: data.to,
    text: message.body,
    injection_mode: injectionMode,
    attachments,

    // Internal: delivery record for the recipient — stripped by route before response
    _delivery: dmDelivery,
    _delivery_rejections: deliveryOutcomes.rejections,
  };
}

export async function listConversations(db: Db, workspaceId: string, agentId: string) {
  const conversationRows = await db
    .select({
      id: dmConversations.id,
      dmType: dmConversations.dmType,
      name: dmConversations.name,
      channelId: dmConversations.channelId,
      createdAt: dmConversations.createdAt,
    })
    .from(dmConversations)
    .innerJoin(dmParticipants, eq(dmParticipants.conversationId, dmConversations.id))
    .where(
      and(
        eq(dmConversations.workspaceId, workspaceId),
        eq(dmParticipants.agentId, agentId),
        isNull(dmParticipants.leftAt),
      ),
    );

  if (conversationRows.length === 0) {
    return [];
  }

  const conversationIds = conversationRows.map((row) => row.id);
  const channelIds = conversationRows.map((row) => row.channelId);

  const participantRows = await db
    .select({
      conversationId: dmParticipants.conversationId,
      agentId: dmParticipants.agentId,
      agentName: agents.name,
    })
    .from(dmParticipants)
    .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
    .where(inArray(dmParticipants.conversationId, conversationIds));

  const counts = await db
    .select({ channelId: messages.channelId, count: sql<number>`count(*)` })
    .from(messages)
    .where(inArray(messages.channelId, channelIds))
    .groupBy(messages.channelId);

  const latestMessageIds = await db
    .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
    .from(messages)
    .where(inArray(messages.channelId, channelIds))
    .groupBy(messages.channelId);

  const lastIds = latestMessageIds.map((row) => row.lastId).filter(Boolean);
  const lastMessages = lastIds.length > 0
    ? await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        agentId: messages.agentId,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.id, lastIds))
    : [];

  const participantsByConversation = new Map<string, Array<{ agent_id: string; agent_name: string }>>();
  for (const row of participantRows) {
    const list = participantsByConversation.get(row.conversationId) || [];
    list.push({ agent_id: row.agentId, agent_name: row.agentName });
    participantsByConversation.set(row.conversationId, list);
  }

  const countByChannel = new Map<string, number>(
    counts.map((row) => [row.channelId, row.count]),
  );

  const lastMessageByChannel = new Map<string, typeof lastMessages[number]>(
    lastMessages.map((row) => [row.channelId, row]),
  );

  return conversationRows.map((conv) => {
    const lastMessage = lastMessageByChannel.get(conv.channelId);
    return {
      id: conv.id,
      type: conv.dmType,
      name: conv.name,
      participants: participantsByConversation.get(conv.id) || [],
      last_message: lastMessage
        ? {
          id: lastMessage.id,
          text: lastMessage.body,
          agent_id: lastMessage.agentId,
          created_at: lastMessage.createdAt.toISOString(),
        }
        : null,
      unread_count: countByChannel.get(conv.channelId) ?? 0,
      created_at: conv.createdAt.toISOString(),
    };
  });
}

export async function getDmMessages(
  db: Db,
  workspaceId: string,
  conversationId: string,
  agentId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
): Promise<DmMessage[]> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

  // Verify agent is a participant
  const [participant] = await db
    .select()
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.agentId, agentId),
        isNull(dmParticipants.leftAt),
      ),
    );

  if (!participant) {
    throw codedError('Not a participant in this conversation', 'forbidden', 403);
  }

  // Get the conversation to find the channel
  const [conv] = await db
    .select()
    .from(dmConversations)
    .where(
      and(
        eq(dmConversations.id, conversationId),
        eq(dmConversations.workspaceId, workspaceId),
      ),
    );

  if (!conv) {
    throw codedError('Conversation not found', 'not_found', 404);
  }

  const conditions = [eq(messages.channelId, conv.channelId)];

  // Compare/sort on the indexed text PK directly: snowflake ids are fixed-width
  // (19 digits) so lexical order matches numeric order, and this keeps the PK
  // index usable for range scans (a CAST would force a full scan).
  if (opts.before) {
    conditions.push(lt(messages.id, opts.before));
  }
  if (opts.after) {
    conditions.push(gt(messages.id, opts.after));
  }

  const rows = await db
    .select({
      id: messages.id,
      agentId: messages.agentId,
      agentName: agents.name,
      body: messages.body,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(agents, eq(messages.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(sql`${messages.id} DESC`)
    .limit(limit);

  const attachmentMap = await fetchAttachmentsBatch(db, workspaceId, rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agentId,
    agent_name: r.agentName,
    text: r.body,
    injection_mode: r.metadata?.injection_mode as 'wait' | 'steer' | undefined,
    attachments: attachmentMap.get(r.id) || [],
    created_at: r.createdAt.toISOString(),
  }));
}
