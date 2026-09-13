import { eq, and, or, sql, isNull, ne, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import {
  messages,
  channels,
  channelMembers,
  dmConversations,
  agents,
  dmParticipants,
} from '../db/schema.js';
import { queryInChunks } from '../lib/queryChunks.js';
import { parseMessageMentions } from './mentions.js';

type Db = ReturnType<typeof getDb>;

export async function getInbox(db: Db, workspaceId: string, agentId: string) {
  const unreadChannels = await db.all<{ channel_name: string; unread_count: number }>(sql`
    SELECT ch.name AS channel_name, count(*) AS unread_count
    FROM channel_members cm
    JOIN channels ch ON ch.id = cm.channel_id
    JOIN messages m ON m.channel_id = cm.channel_id
    WHERE cm.agent_id = ${agentId}
      AND ch.workspace_id = ${workspaceId}
      AND ch.channel_type = 0
      AND ch.is_archived = false
      AND m.thread_id IS NULL
      AND m.agent_id != ${agentId}
      AND (cm.last_read_id IS NULL OR m.id > cm.last_read_id)
    GROUP BY cm.channel_id, ch.name
    HAVING count(*) > 0
  `);

  // 2. Mentions: @agentName in message body
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId));
  const agentName = agent?.name ?? '';

  // Mentions must match the canonical engine semantics: an EXACT `@handle`
  // token (escaped `\@x`, `user@x`, and prefix/superstring names are NOT
  // mentions), delivered only where the agent has live access — a member of a
  // live channel (channel_type 0) or a participant of a live DM (channel_type
  // != 0). SQL narrows candidates with the ESCAPED LITERAL name; a keyset scan
  // then walks history in bounded batches until 20 canonical matches or source
  // exhaustion, so a valid older mention behind a batch of false candidates is
  // never silently dropped. Memory is bounded per batch.
  const MAX_MENTIONS = 20;
  const MENTION_BATCH = 200;
  // Bound the total scan so inbox latency does not grow without limit with
  // workspace history; 20 canonical matches are normally found well inside it.
  const MENTION_SCAN_MAX = 10_000;
  let scanned = 0;
  const mentionsEnriched: Array<{
    id: string;
    channel_name: string;
    agent_name: string;
    text: string;
    created_at: string;
  }> = [];
  if (agentName) {
    const escapedName = agentName.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    let cursor: string | undefined;
    for (;;) {
      const batch = await db
        .select({
          id: messages.id,
          channelName: channels.name,
          agentName: agents.name,
          body: messages.body,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .innerJoin(agents, eq(messages.agentId, agents.id))
        .leftJoin(
          channelMembers,
          and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.agentId, agentId)),
        )
        .leftJoin(dmConversations, eq(dmConversations.channelId, messages.channelId))
        .leftJoin(
          dmParticipants,
          and(
            eq(dmParticipants.conversationId, dmConversations.id),
            eq(dmParticipants.agentId, agentId),
            isNull(dmParticipants.leftAt),
          ),
        )
        .where(
          and(
            eq(messages.workspaceId, workspaceId),
            eq(channels.isArchived, false),
            ne(messages.agentId, agentId), // exclude self-mentions
            sql`${messages.body} LIKE ${'%@' + escapedName + '%'} ESCAPE '\\'`,
            or(
              and(eq(channels.channelType, 0), eq(channelMembers.agentId, agentId)),
              and(ne(channels.channelType, 0), eq(dmParticipants.agentId, agentId)),
            ),
            // Length-then-lexical keyset: snowflake ids are decimal strings, so
            // ordering by (length(id), id) is chronological across MIXED decimal
            // lengths with no numeric precision loss (a bare text compare is not),
            // and stays length,id index-friendly. The cursor predicate matches
            // the ORDER BY exactly.
            ...(cursor
              ? [
                  sql`(length(${messages.id}) < length(${cursor})
                    OR (length(${messages.id}) = length(${cursor}) AND ${messages.id} < ${cursor}))`,
                ]
              : []),
          ),
        )
        .orderBy(sql`length(${messages.id}) DESC, ${messages.id} DESC`)
        .limit(MENTION_BATCH);
      if (batch.length === 0) break;
      scanned += batch.length;
      for (const row of batch) {
        if (mentionsEnriched.length >= MAX_MENTIONS) break;
        if (parseMessageMentions(row.body).includes(agentName)) {
          mentionsEnriched.push({
            id: row.id,
            channel_name: row.channelName ?? 'unknown',
            agent_name: row.agentName ?? 'unknown',
            text: row.body,
            created_at: row.createdAt.toISOString(),
          });
        }
      }
      if (mentionsEnriched.length >= MAX_MENTIONS) break;
      if (scanned >= MENTION_SCAN_MAX) break;
      cursor = batch[batch.length - 1].id;
      if (batch.length < MENTION_BATCH) break;
    }
  }

  // 3. Unread DMs (1:1 + group)
  const unreadDmRows = await db.all<{
    conversation_id: string;
    channel_id: string;
    unread_count: number;
  }>(sql`
    SELECT dc.id AS conversation_id, dc.channel_id, count(m.id) AS unread_count
    FROM dm_conversations dc
    JOIN dm_participants dp
      ON dp.conversation_id = dc.id
     AND dp.agent_id = ${agentId}
     AND dp.left_at IS NULL
    LEFT JOIN channel_members cm
      ON cm.channel_id = dc.channel_id
     AND cm.agent_id = ${agentId}
    JOIN messages m
      ON m.channel_id = dc.channel_id
     AND m.agent_id != ${agentId}
     AND (cm.last_read_id IS NULL OR m.id > cm.last_read_id)
    WHERE dc.workspace_id = ${workspaceId}
    GROUP BY dc.id, dc.channel_id
    HAVING count(m.id) > 0
  `);

  const unreadDms = [];
  if (unreadDmRows.length > 0) {
    const conversationIds = unreadDmRows.map((row) => row.conversation_id);
    const channelIds = unreadDmRows.map((row) => row.channel_id);

    const otherParticipants = await queryInChunks(conversationIds, (ids) => db
      .select({
        conversationId: dmParticipants.conversationId,
        name: agents.name,
      })
      .from(dmParticipants)
      .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
      .where(
        and(
          inArray(dmParticipants.conversationId, ids),
          ne(dmParticipants.agentId, agentId),
          isNull(dmParticipants.leftAt),
        ),
      ));

    const latestMessageIds = await queryInChunks(channelIds, (ids) => db
      .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
      .from(messages)
      .where(inArray(messages.channelId, ids))
      .groupBy(messages.channelId));

    const lastIds = latestMessageIds.map((row) => row.lastId).filter(Boolean);
    const lastMessages = await queryInChunks(lastIds, (ids) => db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.id, ids)));

    const otherParticipantByConversation = new Map<string, string>();
    for (const participant of otherParticipants) {
      if (!otherParticipantByConversation.has(participant.conversationId)) {
        otherParticipantByConversation.set(participant.conversationId, participant.name);
      }
    }

    const lastMessageByChannel = new Map<string, typeof lastMessages[number]>(
      lastMessages.map((row) => [row.channelId, row]),
    );

    for (const row of unreadDmRows) {
      const lastMsg = lastMessageByChannel.get(row.channel_id);
      unreadDms.push({
        conversation_id: row.conversation_id,
        from: otherParticipantByConversation.get(row.conversation_id) ?? 'unknown',
        unread_count: row.unread_count,
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

  // 4. Recent reactions on the agent's own messages (from other agents)
  const reactionRows = await db.all<{
    message_id: string;
    channel_name: string;
    emoji: string;
    agent_name: string;
    created_at: string;
  }>(sql`
    SELECT r.message_id, ch.name AS channel_name, r.emoji,
           a.name AS agent_name, datetime(r.created_at, 'unixepoch') AS created_at
    FROM reactions r
    JOIN messages m ON m.id = r.message_id
    JOIN channels ch ON ch.id = m.channel_id
    JOIN agents a ON a.id = r.agent_id
    WHERE m.agent_id = ${agentId}
      AND m.workspace_id = ${workspaceId}
      AND r.agent_id != ${agentId}
    ORDER BY r.created_at DESC
    LIMIT 20
  `);

  return {
    unread_channels: unreadChannels,
    mentions: mentionsEnriched,
    unread_dms: unreadDms,
    recent_reactions: reactionRows,
  };
}
