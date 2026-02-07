import { eq, and, sql, lt, gt } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { messages, agents, channels } from '../db/schema.js';

export async function searchMessages(
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
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);

  // Build tsquery from user input
  const tsquery = opts.q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(Boolean)
    .join(' & ');

  if (!tsquery) return [];

  const conditions: ReturnType<typeof eq>[] = [
    eq(messages.workspaceId, workspaceId),
    sql`${messages.searchVector} @@ to_tsquery('english', ${tsquery})`,
  ];

  // Optional channel filter
  if (opts.channel) {
    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, opts.channel)));
    if (ch) {
      conditions.push(eq(messages.channelId, ch.id));
    }
  }

  // Optional agent filter
  if (opts.from) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, opts.from)));
    if (agent) {
      conditions.push(eq(messages.agentId, agent.id));
    }
  }

  // Cursor pagination
  if (opts.before) {
    conditions.push(lt(messages.id, opts.before));
  }
  if (opts.after) {
    conditions.push(gt(messages.id, opts.after));
  }

  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      agentId: messages.agentId,
      body: messages.body,
      createdAt: messages.createdAt,
      rank: sql<number>`ts_rank(${messages.searchVector}, to_tsquery('english', ${tsquery}))`,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(sql`ts_rank(${messages.searchVector}, to_tsquery('english', ${tsquery})) DESC`)
    .limit(limit);

  // Enrich with channel name and agent name
  const enriched = [];
  for (const row of rows) {
    const [ch] = await db.select().from(channels).where(eq(channels.id, row.channelId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId));

    enriched.push({
      id: row.id,
      channel_name: ch?.name ?? 'unknown',
      agent_name: agent?.name ?? 'unknown',
      text: row.body,
      created_at: row.createdAt.toISOString(),
      relevance_score: row.rank,
    });
  }

  return enriched;
}
