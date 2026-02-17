import { eq, and, sql, gt, isNull, ne } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import {
  messages,
  channels,
  channelMembers,
  agents,
  dmConversations,
  dmParticipants,
} from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

export async function getInbox(db: Db, workspaceId: string, agentId: string) {
  // 1. Unread channels: messages.id > channel_members.lastReadId, exclude own, top-level only
  const memberships = await db
    .select()
    .from(channelMembers)
    .innerJoin(channels, eq(channelMembers.channelId, channels.id))
    .where(
      and(
        eq(channelMembers.agentId, agentId),
        eq(channels.workspaceId, workspaceId),
        eq(channels.channelType, 0), // text channels only, not DMs
      ),
    );

  const unreadChannels = [];
  for (const row of memberships) {
    const conditions = [
      eq(messages.channelId, row.channel_members.channelId),
      isNull(messages.threadId), // top-level only
      ne(messages.agentId, agentId), // exclude own
    ];

    if (row.channel_members.lastReadId) {
      conditions.push(gt(messages.id, row.channel_members.lastReadId));
    }

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(...conditions));

    const count = result?.count ?? 0;
    if (count > 0) {
      unreadChannels.push({
        channel_name: row.channels.name,
        unread_count: count,
      });
    }
  }

  // 2. Mentions: @agentName in message body
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const agentName = agent?.name ?? '';

  const mentionRows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      agentId: messages.agentId,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.workspaceId, workspaceId),
        sql`${messages.body} LIKE ${'%@' + agentName + '%'}`,
        ne(messages.agentId, agentId), // exclude self-mentions
      ),
    )
    .orderBy(sql`${messages.id} DESC`)
    .limit(20);

  const mentionsEnriched = [];
  for (const row of mentionRows) {
    const [ch] = await db.select().from(channels).where(eq(channels.id, row.channelId));
    const [fromAgent] = await db.select().from(agents).where(eq(agents.id, row.agentId));
    mentionsEnriched.push({
      id: row.id,
      channel_name: ch?.name ?? 'unknown',
      agent_name: fromAgent?.name ?? 'unknown',
      text: row.body,
      created_at: row.createdAt.toISOString(),
    });
  }

  // 3. Unread DMs (1:1 + group)
  const dmParticipantRows = await db
    .select()
    .from(dmParticipants)
    .innerJoin(dmConversations, eq(dmParticipants.conversationId, dmConversations.id))
    .where(
      and(
        eq(dmParticipants.agentId, agentId),
        isNull(dmParticipants.leftAt),
        eq(dmConversations.workspaceId, workspaceId),
      ),
    );

  const unreadDms = [];
  for (const row of dmParticipantRows) {
    const channelId = row.dm_conversations.channelId;

    // Get membership for read cursor
    const [membership] = await db
      .select()
      .from(channelMembers)
      .where(
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)),
      );

    const conditions = [
      eq(messages.channelId, channelId),
      ne(messages.agentId, agentId),
    ];

    if (membership?.lastReadId) {
      conditions.push(gt(messages.id, membership.lastReadId));
    }

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(...conditions));

    const count = result?.count ?? 0;
    if (count > 0) {
      // Get last message
      const [lastMsg] = await db
        .select()
        .from(messages)
        .where(eq(messages.channelId, channelId))
        .orderBy(sql`${messages.id} DESC`)
        .limit(1);

      // Get the OTHER participant in the conversation (not the requesting agent)
      const [otherParticipant] = await db
        .select({ name: agents.name })
        .from(dmParticipants)
        .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
        .where(
          and(
            eq(dmParticipants.conversationId, row.dm_conversations.id),
            ne(dmParticipants.agentId, agentId),
            isNull(dmParticipants.leftAt),
          ),
        )
        .limit(1);

      unreadDms.push({
        conversation_id: row.dm_conversations.id,
        from: otherParticipant?.name ?? 'unknown',
        unread_count: count,
        last_message: lastMsg
          ? {
              id: lastMsg.id,
              text: lastMsg.body,
              created_at: lastMsg.createdAt.toISOString(),
            }
          : null,
      });
    }
  }

  return {
    unread_channels: unreadChannels,
    mentions: mentionsEnriched,
    unread_dms: unreadDms,
  };
}
