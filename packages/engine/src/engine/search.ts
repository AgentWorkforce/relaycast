import { eq, and, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, channels } from '../db/schema.js';
import { buildFtsQuery } from './searchQuery.js';

type Db = ReturnType<typeof getDb>;

export async function searchMessages(
  db: Db,
  workspaceId: string,
  opts: {
    q: string;
    channel?: string;
    from?: string;
    limit?: number;
    before?: string;
    after?: string;
  },
) {
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);

  const ftsQuery = buildFtsQuery(opts.q);
  if (!ftsQuery) return [];

  // Resolve optional filters to IDs
  let channelId: string | undefined;
  if (opts.channel) {
    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, opts.channel)));
    // A requested channel filter that resolves to nothing must yield no results,
    // not silently fall through to an unfiltered search.
    if (!ch) return [];
    channelId = ch.id;
  }

  let agentId: string | undefined;
  if (opts.from) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, opts.from)));
    if (!agent) return [];
    agentId = agent.id;
  }

  // Build the FTS5 query with parameterized SQL.
  // bm25() returns negative values where more negative = more relevant,
  // so ORDER BY rank ASC gives best results first.
  const rows = await db.all<{
    id: string;
    channel_id: string;
    channel_name: string;
    conversation_id: string | null;
    agent_id: string;
    agent_name: string | null;
    body: string;
    created_at: number;
    rank: number;
  }>(sql`
    SELECT m.id, m.channel_id, c.name AS channel_name, dc.id AS conversation_id, m.agent_id, a.name AS agent_name, m.body, m.created_at,
           bm25(messages_fts) AS rank
    FROM messages_fts fts
    JOIN messages m ON m.id = fts.id
    JOIN channels c ON c.id = m.channel_id
    LEFT JOIN dm_conversations dc ON dc.channel_id = c.id
    LEFT JOIN agents a ON a.id = m.agent_id
    WHERE messages_fts MATCH ${ftsQuery}
      AND m.workspace_id = ${workspaceId}
      ${channelId ? sql`AND m.channel_id = ${channelId}` : sql``}
      ${agentId ? sql`AND m.agent_id = ${agentId}` : sql``}
      ${opts.before ? sql`AND m.id < ${opts.before}` : sql``}
      ${opts.after ? sql`AND m.id > ${opts.after}` : sql``}
    ORDER BY rank, m.id DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    id: row.id,
    channel_id: row.channel_id,
    channel_name: row.channel_name || 'unknown',
    conversation_id: row.conversation_id,
    agent_name: row.agent_name || 'unknown',
    text: row.body,
    created_at: new Date(row.created_at * 1000).toISOString(),
    relevance_score: row.rank,
  }));
}
