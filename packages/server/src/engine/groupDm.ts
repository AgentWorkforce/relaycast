import { eq, and, sql, isNull } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, dmConversations, dmParticipants } from '../db/schema.js';
import { generateId } from './snowflake.js';

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
  data: { text: string; mode?: 'wait' | 'steer' },
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
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));

  const messageId = generateId();
  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId,
      channelId: conv.channelId,
      agentId,
      body: data.text,
      hasAttachments: false,
      metadata: { injection_mode: data.mode ?? 'wait' },
    })
    .returning();

  const injectionMode = data.mode ?? 'wait';
  return {
    // Canonical converged shape (new)
    conversation_id: conversationId,
    message: {
      id: message.id,
      agent_id: message.agentId,
      agent_name: fromAgent?.name ?? '',
      text: message.body,
      injection_mode: injectionMode,
    },
    created_at: message.createdAt.toISOString(),

    // Deprecated legacy shape (kept for backward compatibility)
    // TODO(major): remove legacy top-level group-DM fields after client major rollout.
    id: message.id,
    agent_id: message.agentId,
    text: message.body,
    injection_mode: injectionMode,
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
