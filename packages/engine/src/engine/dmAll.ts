import { eq, and, sql, inArray } from 'drizzle-orm';
import type { DmMessage, WorkspaceDmConversation } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import {
  dmConversations,
  dmParticipants,
  messages,
  agents,
} from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function listAllDmConversations(db: Db, workspaceId: string): Promise<WorkspaceDmConversation[]> {
  const conversations = await db
    .select({
      id: dmConversations.id,
      dmType: dmConversations.dmType,
      name: dmConversations.name,
      channelId: dmConversations.channelId,
      createdAt: dmConversations.createdAt,
    })
    .from(dmConversations)
    .where(eq(dmConversations.workspaceId, workspaceId));

  if (conversations.length === 0) {
    return [];
  }

  const conversationIds = conversations.map((convo) => convo.id);
  const channelIds = conversations.map((convo) => convo.channelId);

  const participantRows = await db
    .select({
      conversationId: dmParticipants.conversationId,
      agentName: agents.name,
    })
    .from(dmParticipants)
    .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
    .where(inArray(dmParticipants.conversationId, conversationIds));

  const messageCounts = await db
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
  const latestMessages = lastIds.length > 0
    ? await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        body: messages.body,
        createdAt: messages.createdAt,
        agentName: agents.name,
      })
      .from(messages)
      .innerJoin(agents, eq(messages.agentId, agents.id))
      .where(inArray(messages.id, lastIds))
    : [];

  const participantsByConversation = new Map<string, string[]>();
  for (const row of participantRows) {
    const list = participantsByConversation.get(row.conversationId) || [];
    list.push(row.agentName);
    participantsByConversation.set(row.conversationId, list);
  }

  const messageCountByChannel = new Map<string, number>(
    messageCounts.map((row) => [row.channelId, row.count]),
  );
  const latestByChannel = new Map<string, typeof latestMessages[number]>(
    latestMessages.map((row) => [row.channelId, row]),
  );

  return conversations.map((convo) => {
    const lastMsg = latestByChannel.get(convo.channelId);
    return {
      id: convo.id,
      channel_id: convo.channelId,
      type: convo.dmType,
      participants: participantsByConversation.get(convo.id) || [],
      last_message: lastMsg
        ? {
          text: lastMsg.body,
          agent_name: lastMsg.agentName,
          created_at: lastMsg.createdAt.toISOString(),
        }
        : null,
      message_count: messageCountByChannel.get(convo.channelId) ?? 0,
    };
  });
}

export async function getDmMessagesForWorkspace(
  db: Db,
  workspaceId: string,
  conversationId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
): Promise<DmMessage[]> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

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

  // Snowflake ids vary in digit width over time; compare/sort numerically so
  // pagination is stable across the width boundary (lexicographic would skip/repeat).
  const conditions = [eq(messages.channelId, conv.channelId)];
  if (opts.before) conditions.push(sql`CAST(${messages.id} AS INTEGER) < CAST(${opts.before} AS INTEGER)`);
  if (opts.after) conditions.push(sql`CAST(${messages.id} AS INTEGER) > CAST(${opts.after} AS INTEGER)`);

  const rows = await db
    .select({
      id: messages.id,
      agentId: messages.agentId,
      agentName: agents.name,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(agents, eq(messages.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(sql`CAST(${messages.id} AS INTEGER) DESC`)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agentId,
    agent_name: r.agentName,
    text: r.body,
    created_at: r.createdAt.toISOString(),
  }));
}
