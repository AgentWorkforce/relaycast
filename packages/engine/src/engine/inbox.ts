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
import { reportEngineProgress, withEngineOperation } from '../lib/engineDiagnostics.js';

type Db = ReturnType<typeof getDb>;

// The handle alphabet of `parseMessageMentions`.
const MENTION_HANDLE = /^[\w-]+$/;
// Tokens unicode61 actually indexes: `_` and `-` are separators, so a handle
// made only of those characters produces no FTS tokens.
const MENTION_FTS_TOKEN = /^[A-Za-z0-9]+$/;
const MENTION_FTS_CURSOR = 'mention-fts-backfill';
// A shorter final token (`"1"*`, `"dev"*`) makes FTS walk a huge term range.
// Those handles keep the workspace scan, which still matches a trailing letter.
const MIN_FTS_PREFIX = 4;
export const MESSAGE_MENTION_BACKFILL_BATCH = 500;

/**
 * Workspace-scoped FTS5 MATCH for a canonical handle, or null when FTS cannot
 * represent it. The prefix is limited to the `body` column: an unscoped
 * `"1"*` also matches workspace snowflakes and returns every row. The last
 * token is a prefix so `@alice你好` (one unicode61 token) still matches
 * handle `alice`. Callers keep the LIKE and `parseMessageMentions` checks.
 */
function mentionFtsMatch(workspaceId: string, tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  if (!MENTION_HANDLE.test(workspaceId)) return null;
  if (tokens.some((token) => !MENTION_FTS_TOKEN.test(token))) return null;
  const last = tokens[tokens.length - 1] ?? '';
  if (last.length < MIN_FTS_PREFIX) return null;
  return `workspace_id : "${workspaceId}" AND body : "${tokens.join(' ')}"*`;
}

export async function messageMentionIndexReady(db: Db): Promise<boolean> {
  const [row] = await db.all<{ cursor: string }>(
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
  const [saved] = await db.all<{ cursor: string }>(
    sql`SELECT cursor FROM maintenance_cursors WHERE id = ${MENTION_FTS_CURSOR}`,
  );
  if (!saved || saved.cursor === 'complete') return 0;
  const [afterText, untilText] = saved.cursor.split('/');
  const after = Number(afterText);
  const until = Number(untilText);
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(until)) return 0;
  const batchSize = Math.min(Math.max(Math.floor(limit), 1), MESSAGE_MENTION_BACKFILL_BATCH);
  const [page] = await db.all<{ copied: number; next_rowid: number | null }>(sql`
    SELECT count(*) AS copied, max(rowid) AS next_rowid FROM (
      SELECT rowid FROM messages
      WHERE rowid > ${after} AND rowid <= ${until}
      ORDER BY rowid
      LIMIT ${batchSize}
    )
  `);
  const copied = Number(page?.copied ?? 0);
  const nextRowid = page?.next_rowid == null ? null : Number(page.next_rowid);
  const cursor = copied === 0 || nextRowid == null || nextRowid >= until
    ? 'complete'
    : `${nextRowid}/${until}`;
  if (copied === 0 || nextRowid == null) {
    await db.run(sql`UPDATE maintenance_cursors SET cursor = ${cursor} WHERE id = ${MENTION_FTS_CURSOR}`);
    reportEngineProgress({ operation: 'backfill.mention_fts', phase: 'completed', rows: 0, remaining: 0 });
    return 0;
  }
  // Sequential, not runAtomicWrites: on D1 that is drizzle's batch(), which
  // cannot bind a raw `db.run(sql)` statement with parameters (SQLiteRaw has
  // no prepared `stmt`), so every page failed in production. Atomicity is not
  // needed here: rows already indexed (an edit during the copy, or a replay
  // after the cursor update was lost) are skipped, so a second insert of the
  // same rowid cannot fail the docsize primary key and leave the cursor stuck.
  await db.run(sql`
    INSERT INTO messages_mention_fts(rowid, workspace_id, body)
    SELECT rowid, workspace_id, body FROM messages
    WHERE rowid > ${after} AND rowid <= ${nextRowid}
      AND NOT EXISTS (
        SELECT 1 FROM messages_mention_fts_docsize
        WHERE id = messages.rowid
      )
  `);
  await db.run(sql`UPDATE maintenance_cursors SET cursor = ${cursor} WHERE id = ${MENTION_FTS_CURSOR}`);
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

export async function getInbox(db: Db, workspaceId: string, agentId: string) {
  return withEngineOperation('inbox.get', workspaceId, () => getInboxUnlabeled(db, workspaceId, agentId));
}

async function getInboxUnlabeled(db: Db, workspaceId: string, agentId: string) {
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
    const escapedName = agentName.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    // Candidates come from messages_mention_fts once its backfill has caught
    // up. The MATCH includes the workspace id and restricts the prefix to
    // `body`, so a common or numeric handle cannot read other tenants or every
    // row of this workspace. Until the backfill finishes, and for handles FTS
    // cannot represent, the workspace-scoped LIKE scan stays.
    const mentionMatch = await messageMentionIndexReady(db)
      ? mentionFtsMatch(workspaceId, mentionTokens)
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
        .from(mentionMatch ? sql`${messages} NOT INDEXED` : messages)
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
            ...(mentionMatch
              ? [sql`messages.rowid IN (SELECT rowid FROM messages_mention_fts WHERE messages_mention_fts MATCH ${sql.raw(`'${mentionMatch}'`)})`]
              : []),
            sql`${messages.body} LIKE ${'%@' + escapedName + '%'} ESCAPE '\\'`,
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
    JOIN messages m
      ON m.channel_id = dc.channel_id
     AND m.agent_id != ${agentId}
     AND (dp.last_read_id IS NULL OR m.id > dp.last_read_id)
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
