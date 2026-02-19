import { eq, and, desc, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { messages, channels, agents } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function getActivityFeed(
  db: Db,
  workspaceId: string,
  limit: number = 20,
) {
  const effectiveLimit = Math.min(Math.max(limit, 1), 100);

  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      createdAt: messages.createdAt,
      channelId: messages.channelId,
      channelName: channels.name,
      channelType: channels.channelType,
      agentName: agents.name,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .innerJoin(agents, eq(messages.agentId, agents.id))
    .where(eq(messages.workspaceId, workspaceId))
    .orderBy(desc(messages.createdAt))
    .limit(effectiveLimit);

  return rows.map((r) => {
    // channelType 0 = normal channel, 1 = DM channel
    const isDm = r.channelType !== 0;
    if (isDm) {
      return {
        type: 'dm' as const,
        id: r.id,
        conversation_id: r.channelId,
        agent_name: r.agentName,
        text: r.body,
        created_at: r.createdAt.toISOString(),
      };
    }
    return {
      type: 'message' as const,
      id: r.id,
      channel_name: r.channelName,
      agent_name: r.agentName,
      text: r.body,
      created_at: r.createdAt.toISOString(),
    };
  });
}
