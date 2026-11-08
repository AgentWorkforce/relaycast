import { eq, and, or, sql, isNull, ne, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import {
  messages,
  channels,
  channelMembers,
  dmConversations,
  agents,
  dmParticipants,
} from '../db/tables.js';
import { queryInChunks } from '../lib/queryChunks.js';
import { parseMessageMentions } from './mentions.js';
import { reportEngineProgress, withEngineOperation } from '../lib/engineDiagnostics.js';
import * as sqlx from '../db/sqlx.js';
import * as sqliteFts from '../adapters/sqlite/fts.js';

type Db = ReturnType<typeof getDb>;

// The handle alphabet of `parseMessageMentions`.
const MENTION_HANDLE = /^[\w-]+$/;
const MENTION_FTS_CURSOR = 'mention-fts-backfill';
export const MESSAGE_MENTION_BACKFILL_BATCH = 500;

export async function messageMentionIndexReady(db: Db): Promise<boolean> {
  const [row] = await sqlx.all<{ cursor: string }>(db, 
    sql`SELECT cursor FROM maintenance_cursors WHERE id = ${MENTION_FTS_CURSOR}`,
  );
  return row?.cursor === 'complete';
}

/**
 * Copy one bounded batch of messages that existed at migration time into
 * `messages_mention_fts`. Newer rows are already indexed by the insert
 * trigger. Returns how many rows this call copied.
 */
export async function backfillMessageMentionFts(
  db: Db,
  limit = MESSAGE_MENTION_BACKFILL_BATCH,
): Promise<number> {
  return withEngineOperation('backfill.mention_fts', undefined, () => backfillMessageMentionFtsUnlabeled(db, limit));
}

async function backfillMessageMentionFtsUnlabeled(db: Db, limit: number): Promise<number> {
  const start = performance.now();
  const [saved] = await sqlx.all<{ cursor: string }>(db, 
    sql`SELECT cursor FROM maintenance_cursors WHERE id = ${MENTION_FTS_CURSOR}`,
  );
  if (!saved || saved.cursor === 'complete') return 0;
  const [afterText, untilText] = saved.cursor.split('/');
  const after = Number(afterText);
  const until = Number(untilText);
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(until)) return 0;
  const batchSize = Math.min(Math.max(Math.floor(limit), 1), MESSAGE_MENTION_BACKFILL_BATCH);
  const [page] = await sqlx.all<{ copied: number; next_rowid: number | null }>(db,
    sqliteFts.mentionFtsBackfillPage(db, after, until, batchSize));
  const copied = Number(page?.copied ?? 0);
  const nextRowid = page?.next_rowid == null ? null : Number(page.next_rowid);
  const cursor = copied === 0 || nextRowid == null || nextRowid >= until
    ? 'complete'
    : `${nextRowid}/${until}`;
  if (copied === 0 || nextRowid == null) {
    await sqlx.run(db, sql`UPDATE maintenance_cursors SET cursor = ${cursor} WHERE id = ${MENTION_FTS_CURSOR}`);
    reportEngineProgress({ operation: 'backfill.mention_fts', phase: 'completed', rows: 0, remaining: 0 });
    return 0;
  }
  // Sequential, not runAtomicWrites: on D1 that is drizzle's batch(), which
  // cannot bind a raw `db.run(sql)` statement with parameters (SQLiteRaw has
  // no prepared `stmt`), so every page failed in production. Atomicity is not
  // needed here: rows already indexed (an edit during the copy, or a replay
  // after the cursor update was lost) are skipped, so a second insert of the
  // same rowid cannot fail the docsize primary key and leave the cursor stuck.
  await sqlx.run(db, sqliteFts.mentionFtsBackfillInsert(db, after, nextRowid));
  await sqlx.run(db, sql`UPDATE maintenance_cursors SET cursor = ${cursor} WHERE id = ${MENTION_FTS_CURSOR}`);
  reportEngineProgress({
    operation: 'backfill.mention_fts',
    phase: cursor === 'complete' ? 'completed' : 'batch',
    rows: copied,
    // An upper bound: the rowid span still to copy (rowids can have gaps).
    remaining: cursor === 'complete' ? 0 : until - nextRowid,
    durationMs: performance.now() - start,
  });
  return copied;
}

/**
 * Unread predicate for a read cursor. Snowflake ids are unpadded decimal text:
 * length, then text, is chronological; a bare text compare reverses order
 * across a digit boundary. Both arguments are fixed column references.
 */
function messageAfterCursor(id: string, cursor: string) {
  return sql.raw(`(${cursor} IS NULL OR length(${id}) > length(${cursor}) OR (length(${id}) = length(${cursor}) AND ${id} > ${cursor}))`);
}

export async function getInbox(db: Db, workspaceId: string, agentId: string) {
  return withEngineOperation('inbox.get', workspaceId, () => getInboxUnlabeled(db, workspaceId, agentId));
}

async function getInboxUnlabeled(db: Db, workspaceId: string, agentId: string) {
  const unreadChannels = await sqlx.all<{ channel_name: string; unread_count: number }>(db, sql`
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
      AND ${messageAfterCursor('m.id', 'cm.last_read_id')}
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
  // != 0). SQL narrows candidates to bodies containing the literal `@name`; a
  // keyset scan then walks history in bounded batches until 20 canonical
  // matches or source exhaustion, so a valid older mention behind a batch of
  // false candidates is never silently dropped. Memory is bounded per batch.
  const MAX_MENTIONS = 20;
  const MENTION_BATCH = 200;
  const mentionsEnriched: Array<{
    id: string;
    channel_name: string;
    agent_name: string;
    text: string;
    created_at: string;
  }> = [];
  // A canonical mention handle is `[\w-]+`, so a name outside that alphabet can
  // never be mentioned and the history scan is skipped entirely.
  const canMention = MENTION_HANDLE.test(agentName);
  const mentionTokens = canMention ? agentName.split(/[_-]+/).filter(Boolean) : [];
  if (canMention) {
    // Candidates come from messages_mention_fts once its backfill has caught
    // up. The MATCH includes the workspace id and restricts the prefix to
    // `body`, so a common or numeric handle cannot read other tenants or every
    // row of this workspace. Until the backfill finishes, and for handles FTS
    // cannot represent, the workspace-scoped scan stays.
    const mentionMatch = await messageMentionIndexReady(db)
      ? sqliteFts.mentionFtsCandidateFilter(db, workspaceId, mentionTokens)
      : null;
    let cursor: string | undefined;
    for (;;) {
      const batch = await db
        .select({
          // SQL-wrapped: Drizzle rejects bare columns of a table named only
          // through the SQL FROM below, and this keeps their decoders.
          id: sql`${messages.id}`.mapWith(messages.id),
          channelName: channels.name,
          agentName: agents.name,
          body: sql`${messages.body}`.mapWith(messages.body),
          createdAt: sql`${messages.createdAt}`.mapWith(messages.createdAt),
        })
        // NOT INDEXED leaves only the rowid lookups from the FTS candidates;
        // otherwise SQLite (D1 has no ANALYZE stats) walks the workspace index
        // to satisfy the ORDER BY and merely filters on the candidate set.
        // Handles with no FTS tokens keep the ordinary table so that walk
        // stays on idx_messages_workspace_length_id.
        .from(mentionMatch ? sql`${messages} ${sqlx.notIndexed(db)}` : messages)
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
            ...(mentionMatch ? [mentionMatch] : []),
            // instr, not LIKE: D1 rejects LIKE patterns over 50 bytes and agent
            // names have no length cap. `parseMessageMentions` is case-sensitive
            // and needs the literal `@name`, so instr drops no canonical mention.
            sqlx.contains(db, messages.body, '@' + agentName),
            or(
              and(eq(channels.channelType, 0), eq(channelMembers.agentId, agentId)),
              and(ne(channels.channelType, 0), eq(dmParticipants.agentId, agentId)),
            ),
            // Length-then-lexical keyset: snowflake ids are decimal strings, so
            // ordering by (length(id), id) is chronological across MIXED decimal
            // lengths with no numeric precision loss (a bare text compare is not).
            // The cursor predicate matches the ORDER BY exactly. Tradeoff: the
            // scan is bounded per batch but deliberately NOT by a total cap — a
            // total cap would silently drop valid older mentions. When the FTS
            // match is present, that candidate set bounds the rows read.
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
      cursor = batch[batch.length - 1].id;
      if (batch.length < MENTION_BATCH) break;
    }
  }

  // 3. Unread DMs (1:1 + group)
  const unreadDmRows = await sqlx.all<{
    conversation_id: string;
    channel_id: string;
    unread_count: number;
  }>(db, sql`
    SELECT dc.id AS conversation_id, dc.channel_id, count(m.id) AS unread_count
    FROM dm_conversations dc
    JOIN dm_participants dp
      ON dp.conversation_id = dc.id
     AND dp.agent_id = ${agentId}
     AND dp.left_at IS NULL
    JOIN messages m
      ON m.channel_id = dc.channel_id
     AND m.agent_id != ${agentId}
     AND ${messageAfterCursor('m.id', 'dp.last_read_id')}
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
  const reactionRows = await sqlx.all<{
    message_id: string;
    channel_name: string;
    emoji: string;
    agent_name: string;
    created_at: string;
  }>(db, sql`
    SELECT r.message_id, ch.name AS channel_name, r.emoji,
           a.name AS agent_name, ${sqlx.isoFromEpoch(db, sql.raw('r.created_at'), 'datetime')} AS created_at
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
