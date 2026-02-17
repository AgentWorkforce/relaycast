import { eq, sql, desc } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import {
  dmConversations,
  dmParticipants,
  channels,
  messages,
  agents,
} from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function listAllDmConversations(db: Db, workspaceId: string) {
  // Get all DM conversations for this workspace
  const convos = await db
    .select({
      id: dmConversations.id,
      dmType: dmConversations.dmType,
      channelId: dmConversations.channelId,
    })
    .from(dmConversations)
    .where(eq(dmConversations.workspaceId, workspaceId));

  const results = [];
  for (const convo of convos) {
    // Get participants
    const participants = await db
      .select({ agentName: agents.name })
      .from(dmParticipants)
      .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
      .where(eq(dmParticipants.conversationId, convo.id));

    // Get message count
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.channelId, convo.channelId));

    // Get last message
    const [lastMsg] = await db
      .select({
        body: messages.body,
        agentName: agents.name,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(agents, eq(messages.agentId, agents.id))
      .where(eq(messages.channelId, convo.channelId))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    results.push({
      id: convo.id,
      channel_id: convo.channelId,
      type: convo.dmType,
      participants: participants.map((p) => p.agentName),
      last_message: lastMsg
        ? {
            text: lastMsg.body,
            agent_name: lastMsg.agentName,
            created_at: lastMsg.createdAt.toISOString(),
          }
        : null,
      message_count: countRow?.count ?? 0,
    });
  }

  return results;
}
