import { eq, desc } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents, dmConversations } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function getActivityFeed(
  db: Db,
  workspaceId: string,
  limit: number = 20,
) {
  const effectiveLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 100);

  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      createdAt: messages.createdAt,
      channelId: messages.channelId,
      channelName: channels.name,
      channelType: channels.channelType,
      conversationId: dmConversations.id,
      agentId: messages.agentId,
      agentName: agents.name,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .innerJoin(agents, eq(messages.agentId, agents.id))
    .leftJoin(dmConversations, eq(dmConversations.channelId, channels.id))
    .where(eq(messages.workspaceId, workspaceId))
    // Message ids are fixed-width monotonic snowflakes. Ordering directly by
    // id preserves newest-first activity while letting SQLite satisfy both the
    // workspace filter and ordering from idx_messages_workspace. Ordering by
    // created_at first forces D1 to scan and sort the entire workspace history.
    .orderBy(desc(messages.id))
    .limit(effectiveLimit);

  return rows.map((r) => {
    // channelType 0 = normal channel, 1 = DM channel
    const isDm = r.channelType !== 0;
    if (isDm) {
      return {
        type: 'dm' as const,
        id: r.id,
        conversation_id: r.conversationId ?? r.channelId,
        agent_id: r.agentId,
        agent_name: r.agentName,
        text: r.body,
        created_at: r.createdAt.toISOString(),
      };
    }
    return {
      type: 'message' as const,
      id: r.id,
      channel_id: r.channelId,
      channel_name: r.channelName,
      channel_type: r.channelType,
      agent_id: r.agentId,
      agent_name: r.agentName,
      text: r.body,
      created_at: r.createdAt.toISOString(),
    };
  });
}
