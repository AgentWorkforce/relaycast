import { eq, and, isNull } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, dmConversations, dmParticipants, messageAttachments } from '../db/schema.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { generateId } from './snowflake.js';
import {
  buildGroupDmDeliveryWrite,
  fetchGroupDeliveryOutcomes,
  type DeliveryOutcomeRecords,
} from './deliveryWrites.js';
import { DEFAULT_MAILBOX_DEPTH_CAP, DEFAULT_MAILBOX_TTL_MS, type MailboxConfig } from './mailboxConfig.js';
import { codedError } from '../lib/httpError.js';
import { resolveSendAttachments } from './attachments.js';

type Db = ReturnType<typeof getDb>;

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
      throw codedError(`Agent "${name}" not found`, 'agent_not_found', 404);
    }
    participantAgents.push(agent);
  }

  const conversationId = generateId();
  const channelId = generateId();

  const allParticipantIds = [creatorAgentId, ...participantAgents.map((a) => a.id)];
  const uniqueIds = [...new Set(allParticipantIds)];

  await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [
      writeDb.insert(channels).values({
        id: channelId,
        workspaceId,
        name: `group-dm-${conversationId}`,
        channelType: 2,
      }),
      writeDb.insert(dmConversations).values({
        id: conversationId,
        workspaceId,
        channelId,
        dmType: 'group',
        name: data.name ?? null,
      }),
    ];

    const participantRows = uniqueIds.map((agentId) => ({
      conversationId,
      agentId,
    }));
    if (participantRows.length > 0) {
      writes.push(writeDb.insert(dmParticipants).values(participantRows));
    }

    return writes;
  });

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
  options: { mailbox?: MailboxConfig } = {},
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

  const [fromAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));

  if (!fromAgent?.name) {
    throw codedError('Sender agent not found', 'internal_error', 500);
  }

  const attachments = await resolveSendAttachments(db, workspaceId, data.attachments);
  const messageId = generateId();
  const hasAttachments = attachments.length > 0;
  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
  };

  // Durable writes run as one atomic unit when the adapter supports it; fanout
  // stays in routes. Delivery recipients are derived by the delivery insert
  // from current active participants.
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [
      writeDb
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
        .returning(),
    ];

    if (attachments.length > 0) {
      const attachmentValues = attachments.map((attachment, idx) => ({
        messageId,
        fileId: attachment.file_id,
        position: idx,
      }));
      writes.push(writeDb.insert(messageAttachments).values(attachmentValues));
    }

    writes.push(
      buildGroupDmDeliveryWrite(writeDb, {
        workspaceId,
        messageId,
        conversationId,
        senderAgentId: agentId,
        mode: data.mode === 'steer' ? 'next-tool-call' : 'immediate',
        ttlMs: mailbox.ttlMs,
        depthCap: mailbox.depthCap,
      }),
    );

    return writes;
  });
  const [message] = results[0] as (typeof messages.$inferSelect)[];
  const deliveryOutcomes: DeliveryOutcomeRecords = await fetchGroupDeliveryOutcomes(db, {
    messageId,
    conversationId,
    senderAgentId: agentId,
  });

  const injectionMode = data.mode ?? 'wait';
  return {
    // Canonical converged shape (new)
    conversation_id: conversationId,
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
    agent_id: message.agentId,
    text: message.body,
    injection_mode: injectionMode,
    attachments,

    // Internal: delivery records for recipients — stripped by route before response
    _deliveries: deliveryOutcomes.deliveries,
    _delivery_rejections: deliveryOutcomes.rejections,
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
    throw codedError('Not a participant in this conversation', 'forbidden', 403);
  }

  // Find the invitee agent
  const [invitee] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, inviteeAgentName)));

  if (!invitee) {
    throw codedError(`Agent "${inviteeAgentName}" not found`, 'agent_not_found', 404);
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
    throw codedError('Not a participant in this conversation', 'forbidden', 403);
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
