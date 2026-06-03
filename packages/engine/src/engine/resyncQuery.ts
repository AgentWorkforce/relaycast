import { sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { transformForClient, type WsEvent } from './wsTransform.js';

type Db = ReturnType<typeof getDb>;

/**
 * Replay events an agent missed while disconnected, for resync gaps larger than
 * the in-memory ring buffer. Queries channel messages, DMs/group DMs, and
 * reactions in the agent's scope created after `since`, and returns
 * client-shaped event payloads in chronological order (each tagged
 * `replayed: true`).
 *
 * Shared by every {@link ConnectionRegistry} adapter so the gap-fill is
 * byte-identical across the Node (SQLite) and Cloudflare (D1) runtimes.
 */
export async function replayMissedEvents(
  db: Db,
  agentId: string,
  workspaceId: string,
  since: string, // ISO timestamp
): Promise<Record<string, unknown>[]> {
  const sinceMs = new Date(since).getTime();
  if (!Number.isFinite(sinceMs)) {
    // Invalid `since` — return nothing rather than running queries with NaN.
    return [];
  }
  const sinceUnix = Math.floor(sinceMs / 1000);
  const events: Array<{ ts: number; payload: Record<string, unknown> }> = [];

  const buildEvent = (
    type: string,
    data: Record<string, unknown>,
    channelId?: string,
  ): Record<string, unknown> => {
    const event: WsEvent = {
      type,
      workspace_id: workspaceId,
      channel_id: channelId,
      data,
      timestamp: new Date().toISOString(),
    };
    return transformForClient(event);
  };

  // Channel messages (including thread replies) after `since`.
  const channelRows = await db.all<Record<string, unknown>>(sql`
    SELECT m.id, m.channel_id, m.agent_id, m.body, m.thread_id,
           m.created_at, c.name AS channel_name, a.name AS agent_name
    FROM messages m
    JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.agent_id = ${agentId}
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE m.workspace_id = ${workspaceId}
      AND m.created_at > ${sinceUnix}
    ORDER BY m.created_at ASC
    LIMIT 1000
  `);

  for (const row of channelRows) {
    const data = {
      id: row.id,
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      agent_id: row.agent_id,
      from_name: row.agent_name,
      text: row.body,
      thread_id: row.thread_id,
      created_at: new Date((row.created_at as number) * 1000).toISOString(),
    } as Record<string, unknown>;

    const type = row.thread_id ? 'thread.reply' : 'message.created';
    events.push({
      ts: (row.created_at as number) * 1000,
      payload: { ...buildEvent(type, data, row.channel_id as string | undefined), replayed: true },
    });
  }

  // DM + group DM messages after `since`.
  const dmRows = await db.all<Record<string, unknown>>(sql`
    SELECT m.id, m.channel_id, m.agent_id, m.body, m.created_at,
           a.name AS agent_name, dc.id AS conversation_id, dc.dm_type
    FROM dm_conversations dc
    JOIN dm_participants dp ON dp.conversation_id = dc.id AND dp.agent_id = ${agentId} AND dp.left_at IS NULL
    JOIN messages m ON m.channel_id = dc.channel_id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE dc.workspace_id = ${workspaceId}
      AND m.created_at > ${sinceUnix}
    ORDER BY m.created_at ASC
    LIMIT 1000
  `);

  for (const row of dmRows) {
    const type = row.dm_type === 'group' ? 'group_dm.received' : 'dm.received';
    const data = {
      id: row.id,
      conversation_id: row.conversation_id,
      agent_id: row.agent_id,
      from_agent_id: row.agent_id,
      from_name: row.agent_name,
      text: row.body,
      created_at: new Date((row.created_at as number) * 1000).toISOString(),
    } as Record<string, unknown>;
    events.push({
      ts: (row.created_at as number) * 1000,
      payload: { ...buildEvent(type, data, row.channel_id as string | undefined), replayed: true },
    });
  }

  // Reaction additions after `since`.
  const reactionRows = await db.all<Record<string, unknown>>(sql`
    SELECT r.message_id, r.emoji, r.created_at,
           a.name AS agent_name,
           m.channel_id, c.name AS channel_name, c.channel_type,
           dc.dm_type, dc.id AS conversation_id
    FROM reactions r
    JOIN messages m ON m.id = r.message_id
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN dm_conversations dc ON dc.channel_id = m.channel_id
    LEFT JOIN dm_participants dp ON dp.conversation_id = dc.id AND dp.agent_id = ${agentId} AND dp.left_at IS NULL
    LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.agent_id = ${agentId}
    LEFT JOIN agents a ON a.id = r.agent_id
    WHERE m.workspace_id = ${workspaceId}
      AND r.created_at > ${sinceUnix}
      AND (cm.agent_id IS NOT NULL OR dp.agent_id IS NOT NULL)
    ORDER BY r.created_at ASC
    LIMIT 1000
  `);

  for (const row of reactionRows) {
    const data = {
      message_id: row.message_id,
      emoji: row.emoji,
      agent_name: row.agent_name,
      channel_name: row.channel_name,
      action: 'added',
    } as Record<string, unknown>;
    events.push({
      ts: (row.created_at as number) * 1000,
      payload: { ...buildEvent('message.reacted', data, row.channel_id as string | undefined), replayed: true },
    });
  }

  events.sort((a, b) => a.ts - b.ts);
  return events.map((e) => e.payload);
}
