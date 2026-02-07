import { eq, and, sql, lt, gt, isNull } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import {
  messages,
  channels,
  agents,
  dmConversations,
  dmParticipants,
} from '../db/schema.js';
import { generateId } from './snowflake.js';

export async function sendDm(
  workspaceId: string,
  fromAgentId: string,
  data: { to: string; text: string },
) {
  const db = getDb();

  // Resolve the target agent by name
  const [toAgent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.to)));

  if (!toAgent) {
    const err = new Error(`Agent "${data.to}" not found`);
    Object.assign(err, { code: 'agent_not_found', status: 404 });
    throw err;
  }

  // Check for existing DM conversation between these two agents
  // Find conversations where both agents are participants and dm_type is '1:1'
  const existingConversations = await db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(eq(dmParticipants.agentId, fromAgentId));

  let conversationId: string | null = null;

  for (const conv of existingConversations) {
    // Check if target agent is also in this conversation
    const [match] = await db
      .select()
      .from(dmParticipants)
      .where(
        and(
          eq(dmParticipants.conversationId, conv.conversationId),
          eq(dmParticipants.agentId, toAgent.id),
        ),
      );

    if (match) {
      // Verify it's a 1:1 DM conversation
      const [convRecord] = await db
        .select()
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.id, conv.conversationId),
            eq(dmConversations.dmType, '1:1'),
            eq(dmConversations.workspaceId, workspaceId),
          ),
        );
      if (convRecord) {
        conversationId = convRecord.id;
        break;
      }
    }
  }

  // Auto-create conversation if first message between these agents
  if (!conversationId) {
    conversationId = generateId();
    const channelId = generateId();

    // Create a private channel for the DM (channel_type=1 for DM)
    await db.insert(channels).values({
      id: channelId,
      workspaceId,
      name: `dm-${conversationId}`,
      channelType: 1,
    });

    // Create the DM conversation
    await db.insert(dmConversations).values({
      id: conversationId,
      workspaceId,
      channelId,
      dmType: '1:1',
    });

    // Add both participants
    await db.insert(dmParticipants).values([
      { conversationId, agentId: fromAgentId },
      { conversationId, agentId: toAgent.id },
    ]);
  }

  // Get the channel for this conversation
  const [conv] = await db
    .select()
    .from(dmConversations)
    .where(eq(dmConversations.id, conversationId));

  // Post the message
  const messageId = generateId();
  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId,
      channelId: conv.channelId,
      agentId: fromAgentId,
      body: data.text,
      hasAttachments: false,
    })
    .returning();

  return {
    id: message.id,
    conversation_id: conversationId,
    from_agent_id: message.agentId,
    to: data.to,
    text: message.body,
    created_at: message.createdAt.toISOString(),
  };
}

export async function listConversations(workspaceId: string, agentId: string) {
  const db = getDb();

  // Get all conversations this agent is a participant in
  const participantRows = await db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.agentId, agentId), isNull(dmParticipants.leftAt)));

  const conversations = [];
  for (const row of participantRows) {
    const [conv] = await db
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.id, row.conversationId),
          eq(dmConversations.workspaceId, workspaceId),
        ),
      );
    if (!conv) continue;

    // Get last message
    const [lastMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.channelId, conv.channelId))
      .orderBy(sql`${messages.id} DESC`)
      .limit(1);

    // Get other participants
    const participants = await db
      .select({ agentId: dmParticipants.agentId, agentName: agents.name })
      .from(dmParticipants)
      .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
      .where(eq(dmParticipants.conversationId, conv.id));

    // Get unread count (messages after last read - simplified as total for now)
    const [unreadCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.channelId, conv.channelId));

    conversations.push({
      id: conv.id,
      dm_type: conv.dmType,
      name: conv.name,
      participants: participants.map((p) => ({
        agent_id: p.agentId,
        agent_name: p.agentName,
      })),
      last_message: lastMessage
        ? {
            id: lastMessage.id,
            text: lastMessage.body,
            agent_id: lastMessage.agentId,
            created_at: lastMessage.createdAt.toISOString(),
          }
        : null,
      unread_count: unreadCount?.count ?? 0,
      created_at: conv.createdAt.toISOString(),
    });
  }

  return conversations;
}

export async function getDmMessages(
  workspaceId: string,
  conversationId: string,
  agentId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
) {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

  // Verify agent is a participant
  const [participant] = await db
    .select()
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.agentId, agentId),
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
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(sql`${messages.id} DESC`)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agentId,
    text: r.body,
    created_at: r.createdAt.toISOString(),
  }));
}

