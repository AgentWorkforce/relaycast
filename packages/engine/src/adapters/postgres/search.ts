import { and, eq, sql } from 'drizzle-orm';
import * as sqlx from '../../db/sqlx.js';
import { agents, channels } from '../../db/tables.js';
import { buildFtsQuery } from '../../engine/searchQuery.js';
import type { EngineDb } from '../../ports/database.js';
import type { MessageSearchQuery, MessageSearchResult, SearchIndex } from '../../ports/search.js';
import { pgTsQuery } from '../sqlite/fts.js';

/** Message search over the `messages_fts` tsvector mirror maintained by triggers. */
export class PostgresSearchIndex implements SearchIndex {
  constructor(private readonly db: EngineDb) {}

  async searchMessages({ workspaceId, ...opts }: MessageSearchQuery): Promise<MessageSearchResult[]> {
    const db = this.db;
    const limit = Math.min(Math.max(opts.limit || 20, 1), 100);

    const ftsQuery = buildFtsQuery(opts.q);
    if (!ftsQuery) return [];

    let channelId: string | undefined;
    if (opts.channel) {
      const [ch] = await db.select().from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, opts.channel)));
      if (!ch) return [];
      channelId = ch.id;
    }

    let agentId: string | undefined;
    if (opts.from) {
      const [agent] = await db.select().from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, opts.from)));
      if (!agent) return [];
      agentId = agent.id;
    }

    const query = pgTsQuery(ftsQuery);
    const rows = await sqlx.all<{
      workspace_id: string;
      id: string;
      channel_id: string;
      channel_name: string;
      channel_type: number;
      conversation_id: string | null;
      agent_id: string;
      agent_name: string | null;
      body: string;
      created_at: number;
      rank: number;
    }>(db, sql`
      SELECT m.workspace_id, m.id, m.channel_id, c.name AS channel_name, c.channel_type, dc.id AS conversation_id, m.agent_id, a.name AS agent_name, m.body, m.created_at,
             -ts_rank(fts.document, ${query}) AS rank
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.id
      JOIN channels c ON c.id = m.channel_id
      LEFT JOIN dm_conversations dc ON dc.channel_id = c.id
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE fts.document @@ ${query}
        AND m.workspace_id = ${workspaceId}
        ${channelId ? sql`AND m.channel_id = ${channelId}` : sql``}
        ${agentId ? sql`AND m.agent_id = ${agentId}` : sql``}
        ${opts.before ? sql`AND m.id COLLATE "C" < ${opts.before}` : sql``}
        ${opts.after ? sql`AND m.id COLLATE "C" > ${opts.after}` : sql``}
      ORDER BY rank, m.id COLLATE "C" DESC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      workspace_id: row.workspace_id,
      id: row.id,
      channel_id: row.channel_id,
      channel_name: row.channel_name || 'unknown',
      channel_type: row.channel_type,
      conversation_id: row.conversation_id,
      agent_id: row.agent_id,
      agent_name: row.agent_name || 'unknown',
      text: row.body,
      created_at: new Date(Number(row.created_at) * 1000).toISOString(),
      relevance_score: Number(row.rank),
    }));
  }
}

/** True for a handle branded `pg`; selects this adapter as the default search index. */
export function isPostgresEngineDb(db: object): boolean {
  return (db as { engineDialect?: unknown }).engineDialect === 'pg';
}
