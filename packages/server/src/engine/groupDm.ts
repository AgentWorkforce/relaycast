import { eq, and, isNull, inArray, asc } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, dmConversations, dmParticipants, messageAttachments, files } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

type AttachmentRow = { file_id: string; filename: string; content_type: string; size_bytes: number };

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

export async function createGroupDm(
  db: Db,
  workspaceId: string,
  creatorAgentId: string,
  data: { participants: string[]; name?: string },
) {
  // Resolve participant agent names to IDs
  const participantAgents = [];
  for (const name of data.participants) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

    if (!agent) {
      const err = new Error(`Agent "${name}" not found`);
      Object.assign(err, { code: 'agent_not_found', status: 404 });
      throw err;
    }
    participantAgents.push(agent);
  }

  const conversationId = generateId();
  const channelId = generateId();

  // Create private channel (channel_type=2 for group DM)
  await db.insert(channels).values({
    id: channelId,
    workspaceId,
    name: `group-dm-${conversationId}`,
    channelType: 2,
  });

  // Create group DM conversation
  await db.insert(dmConversations).values({
    id: conversationId,
    workspaceId,
    channelId,
    dmType: 'group',
    name: data.name ?? null,
  });

  // Add creator + all participants
  const allParticipantIds = [creatorAgentId, ...participantAgents.map((a) => a.id)];
  const uniqueIds = [...new Set(allParticipantIds)];

  for (const agentId of uniqueIds) {
    await db.insert(dmParticipants).values({
      conversationId,
      agentId,
    });
  }

  return {
    id: conversationId,
    channel_id: channelId,
    dm_type: 'group',
    name: data.name ?? null,
    participants: uniqueIds.map((id) => ({ agent_id: id })),
    created_at: new Date().toISOString(),
  };
}

export async function postGroupMessage(
  db: Db,
  workspaceId: string,
  conversationId: string,
  agentId: string,
  data: { text: string; attachments?: string[]; mode?: 'wait' | 'steer' },
) {
  // Verify sender is a participant (and hasn't left)
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

  const [fromAgent] = await db
    .select({ name: agents.name, type: agents.type })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));

  if (!fromAgent?.name) {
    const err = new Error('Sender agent not found');
    Object.assign(err, { code: 'internal_error', status: 500 });
    throw err;
  }

  if (data.attachments && data.attachments.length > 0) {
    const unique = new Set(data.attachments);
    if (unique.size !== data.attachments.length) {
      const err = new Error('Invalid attachments: duplicate file ids are not allowed');
      Object.assign(err, { code: 'invalid_attachments', status: 400 });
      throw err;
    }

    const validFiles = await db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          eq(files.status, 'complete'),
          inArray(files.id, data.attachments),
        ),
      );
    const validIds = new Set(validFiles.map((f) => f.id));
    const invalid = data.attachments.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      const err = new Error('Invalid attachments: file ids must exist in workspace and be complete');
      Object.assign(err, { code: 'invalid_attachments', status: 400 });
      throw err;
    }
  }

  const messageId = generateId();
  const hasAttachments = !!(data.attachments && data.attachments.length > 0);
  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId,
      channelId: conv.channelId,
      agentId,
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

  const attachmentMap = hasAttachments
    ? await fetchAttachmentsBatch(db, workspaceId, [messageId])
    : new Map<string, AttachmentRow[]>();
  const attachments = attachmentMap.get(messageId) || [];

  const injectionMode = data.mode ?? 'wait';
  return {
    // Canonical converged shape (new)
    conversation_id: conversationId,
    message: {
      id: message.id,
      agent_id: message.agentId,
      agent_name: fromAgent.name,
      agent_type: fromAgent.type,
      text: message.body,
      injection_mode: injectionMode,
      attachments,
    },
    created_at: message.createdAt.toISOString(),

    // Legacy compatibility fields (scheduled for removal in next major).
    id: message.id,
    agent_id: message.agentId,
    text: message.body,
    injection_mode: injectionMode,
    attachments,
  };
}

export async function addParticipant(
  db: Db,
  workspaceId: string,
  conversationId: string,
  agentId: string,
  inviteeAgentName: string,
) {
  // Verify requester is a participant
  const [requester] = await db
    .select()
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.agentId, agentId),
        isNull(dmParticipants.leftAt),
      ),
    );

  if (!requester) {
    const err = new Error('Not a participant in this conversation');
    Object.assign(err, { code: 'forbidden', status: 403 });
    throw err;
  }

  // Find the invitee agent
  const [invitee] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, inviteeAgentName)));

  if (!invitee) {
    const err = new Error(`Agent "${inviteeAgentName}" not found`);
    Object.assign(err, { code: 'agent_not_found', status: 404 });
    throw err;
  }

  // Check if already a participant
  const [existing] = await db
    .select()
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.agentId, invitee.id),
      ),
    );

  if (existing && !existing.leftAt) {
    return { conversation_id: conversationId, agent: inviteeAgentName, already_member: true };
  }

  if (existing && existing.leftAt) {
    // Re-add by clearing leftAt
    await db
      .update(dmParticipants)
      .set({ leftAt: null })
      .where(
        and(
          eq(dmParticipants.conversationId, conversationId),
          eq(dmParticipants.agentId, invitee.id),
        ),
      );
  } else {
    await db.insert(dmParticipants).values({
      conversationId,
      agentId: invitee.id,
    });
  }

  return { conversation_id: conversationId, agent: inviteeAgentName, already_member: false };
}

export async function removeParticipant(
  db: Db,
  workspaceId: string,
  conversationId: string,
  agentId: string,
) {
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

  // Set left_at timestamp
  await db
    .update(dmParticipants)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.agentId, agentId),
      ),
    );
}
