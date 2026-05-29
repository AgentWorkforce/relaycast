import crypto from 'node:crypto';
import { eq, and, sql, lt, gt, isNull, inArray, asc } from 'drizzle-orm';
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
  deliveries,
} from '../db/schema.js';
import { generateId } from './snowflake.js';
import * as a2aEngine from './a2a.js';
import { logMessage } from './console.js';

type Db = ReturnType<typeof getDb>;

type AttachmentRow = { file_id: string; filename: string; content_type: string; size_bytes: number };

interface SendDmOptions {
  skipA2aIntercept?: boolean;
}

async function fetchAttachmentsBatch(db: Db, workspaceId: string, msgIds: string[]): Promise<Map<string, AttachmentRow[]>> {
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
    .where(and(inArray(messageAttachments.messageId, msgIds), eq(files.workspaceId, workspaceId)))
    .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position));

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

function getDmPairKey(workspaceId: string, agentA: string, agentB: string): string {
  const [first, second] = [agentA, agentB].sort();
  return crypto
    .createHash('sha256')
    .update(`${workspaceId}:${first}:${second}`)
    .digest('hex')
    .slice(0, 24);
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
    const pairKey = getDmPairKey(workspaceId, fromAgentId, toAgentId);
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
    const err = new Error('Conversation not found');
    Object.assign(err, { code: 'not_found', status: 404 });
    throw err;
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
    const err = new Error('Invalid attachments: duplicate file ids are not allowed');
    Object.assign(err, { code: 'invalid_attachments', status: 400 });
    throw err;
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
    const err = new Error('Invalid attachments: file ids must exist in workspace and be complete');
    Object.assign(err, { code: 'invalid_attachments', status: 400 });
    throw err;
  }

  const ordered = new Map(validFiles.map((file) => [file.file_id, file]));
  return attachmentIds.map((id) => ordered.get(id)!);
}

async function persistDmMessage(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  channelId: string,
  data: { text: string; attachments?: string[]; mode?: 'wait' | 'steer' },
  messageId = generateId(),
) {
  const hasAttachments = !!(data.attachments && data.attachments.length > 0);
  const [message] = await db
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
    .returning();

  if (data.attachments && data.attachments.length > 0) {
    const attachmentValues = data.attachments.map((fileId, idx) => ({
      messageId,
      fileId,
      position: idx,
    }));
    await db.insert(messageAttachments).values(attachmentValues);
  }

  return message;
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
    const err = new Error(`Agent "${data.to}" not found`);
    Object.assign(err, { code: 'agent_not_found', status: 404 });
    throw err;
  }

  const [fromAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, fromAgentId)));

  if (!fromAgent?.name) {
    const err = new Error('Sender agent not found');
    Object.assign(err, { code: 'internal_error', status: 500 });
    throw err;
  }

  const conv = await resolveConversation(db, workspaceId, fromAgentId, toAgent.id);
  const attachments = await resolveAttachments(db, workspaceId, data.attachments);
  const a2aTarget = options.skipA2aIntercept
    ? null
    : await a2aEngine.getA2aAgentByRelayName(db, workspaceId, toAgent.name);

  const messageId = generateId();

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

  const message = await persistDmMessage(db, workspaceId, fromAgentId, conv.channelId, data, messageId);

  // Create delivery record for the recipient (skip for @self DMs)
  let dmDelivery: { id: string; agentId: string } | null = null;
  if (toAgent.id !== fromAgentId) {
    const deliveryId = `del_${generateId()}`;
    await db.insert(deliveries).values({
      id: deliveryId,
      workspaceId,
      messageId: message.id,
      agentId: toAgent.id,
      mode: data.mode === 'steer' ? 'next-tool-call' : 'immediate',
      reason: 'dm',
      priority: 'normal',
      status: 'accepted',
    }).onConflictDoNothing();
    dmDelivery = { id: deliveryId, agentId: toAgent.id };
  }

  await logMessage(db, {
    workspaceId,
    messageId: message.id,
    channelId: conv.channelId,
    agentId: fromAgentId,
    conversationId: conv.id,
    deliveryKind: 'dm',
    body: message.body,
    contentType: 'text/plain',
    metadata: {
      target_agent: toAgent.name,
      injection_mode: data.mode ?? 'wait',
      ...(a2aTarget ? { a2a_target_url: a2aTarget.external_url } : {}),
    },
    attachmentCount: attachments.length,
    mentionCount: 0,
    latencyMs: Date.now() - startedAtMs,
  });

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
    const err = new Error('Not a participant in this conversation');
    Object.assign(err, { code: 'forbidden', status: 403 });
    throw err;
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
    const err = new Error('Conversation not found');
    Object.assign(err, { code: 'not_found', status: 404 });
    throw err;
  }

  const conditions = [eq(messages.channelId, conv.channelId)];

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
    injection_mode: (r.metadata as Record<string, unknown> | null)?.injection_mode as 'wait' | 'steer' | undefined,
    attachments: attachmentMap.get(r.id) || [],
    created_at: r.createdAt.toISOString(),
  }));
}
