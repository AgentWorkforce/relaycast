import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

export interface AgentRetentionDb {
  all<T>(query: SQL): PromiseLike<T[]>;
}

const cursorSchema = z.object({
  workspace_id: z.string(),
  cutoff: z.number().int().nonnegative(),
  after: z.string(),
  through: z.string(),
}).strict();

export const agentRetentionSchema = z.object({
  retention_days: z.number().int().min(1).max(36500).default(30),
  delete: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: cursorSchema.optional(),
}).strict();

type Reason = 'not_offline' | 'recent_or_unknown' | 'ownership_protected' | 'history_unverified' | 'history_referenced' | 'eligible';
type Candidate = { id: string; name: string; last_seen: number; reason: Reason };

const requiredIndexes = [
  'idx_messages_agent', 'idx_channels_creator', 'idx_webhooks_creator',
  'idx_reactions_agent', 'idx_directory_ratings_rater', 'idx_routing_failures_agent',
];

/**
 * Deliberately requires absence of ALL ownership evidence. An offline broker,
 * inactive binding, dangling location, or old inventory is not proof of release.
 * Direct-node identities are also retained: remote socket absence cannot be
 * inferred from durable status. No remote liveness RPC can fail open here.
 *
 * Keep this expression identical in preview and DELETE. The latter evaluates it
 * inside the write statement, after any concurrent heartbeat/register/bind.
 */
function reason(cutoff: number, indexesReady: boolean): SQL {
  return sql`CASE
    WHEN a.status NOT IN ('offline', 'released') OR a.status IS NULL THEN 'not_offline'
    WHEN typeof(a.last_seen) != 'integer' OR a.last_seen < 0 OR a.last_seen >= ${cutoff}
      OR typeof(a.created_at) != 'integer' OR a.created_at < 0 OR a.created_at >= ${cutoff}
      THEN 'recent_or_unknown'
    WHEN a.location_type IS NOT 'self_connected'
      OR a.location_node_id IS NOT NULL OR a.origin_node_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM agent_node_bindings b WHERE b.agent_id = a.id)
      OR EXISTS (SELECT 1 FROM nodes n WHERE n.id = 'node_direct_' || a.id)
      THEN 'ownership_protected'
    WHEN a.metadata IS NOT NULL AND NOT json_valid(a.metadata) THEN 'ownership_protected'
    WHEN json_type(COALESCE(a.metadata, '{}')) IS NOT 'object'
      OR json_type(a.metadata, '$.fleet') IS NOT NULL
      OR json_type(a.metadata, '$.broker') IS NOT NULL
      OR json_type(a.metadata, '$.node_id') IS NOT NULL
      THEN 'ownership_protected'
    WHEN ${indexesReady ? 1 : 0} = 0 THEN 'history_unverified'
    WHEN EXISTS (SELECT 1 FROM messages h WHERE h.agent_id = a.id)
      OR EXISTS (SELECT 1 FROM channels h WHERE h.created_by = a.id)
      OR EXISTS (SELECT 1 FROM files h WHERE h.uploaded_by = a.id)
      OR EXISTS (SELECT 1 FROM webhooks h WHERE h.created_by = a.id)
      THEN 'history_referenced'
    ELSE 'eligible' END`;
}

/** One bounded page. Persist the returned cursor only after a successful call. */
export async function retainAgents(
  db: AgentRetentionDb,
  workspaceId: string,
  input: z.input<typeof agentRetentionSchema> = {},
  now = new Date(),
) {
  const options = agentRetentionSchema.parse(input);
  const currentCutoff = Math.max(0, Math.floor(now.getTime() / 1000) - options.retention_days * 86400);
  if (!Number.isSafeInteger(currentCutoff) || currentCutoff < 0) throw new Error('Invalid retention clock');
  const cursor = options.cursor;
  if (cursor && (cursor.workspace_id !== workspaceId || cursor.cutoff > currentCutoff)) {
    throw new Error('Retention cursor workspace or cutoff does not match the requested policy');
  }
  // Resuming may make the boundary older, never newer than the requested window.
  const cutoff = cursor?.cutoff ?? currentCutoff;
  const indexes = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN (${sql.join(requiredIndexes.map(name => sql`${name}`), sql`, `)})`);
  const indexesReady = indexes.length === requiredIndexes.length;
  if (options.delete && !indexesReady) {
    throw new Error('Agent retention requires migration 0052_agent_retention_indexes.sql before deletion');
  }
  const [high] = cursor ? [] : await db.all<{ id: string }>(sql`
    SELECT id FROM agents WHERE workspace_id = ${workspaceId} ORDER BY id DESC LIMIT 1`);
  const through = cursor?.through ?? high?.id ?? '';
  const after = cursor?.after ?? '';
  // LIMIT applies before the correlated ownership/history probes. Protected
  // pages advance too; retained rows cannot pin maintenance to the first page.
  const rows = await db.all<Candidate>(sql`
    WITH page AS MATERIALIZED (
      SELECT id, name, status, last_seen, created_at, location_type,
        location_node_id, origin_node_id, metadata FROM agents
      WHERE workspace_id = ${workspaceId} AND id > ${after} AND id <= ${through}
      ORDER BY id LIMIT ${options.limit}
    ) SELECT id, name, last_seen, ${reason(cutoff, indexesReady)} AS reason FROM page a ORDER BY id`);
  const eligible = rows.filter(row => row.reason === 'eligible');
  let deleted: { id: string }[] = [];
  if (options.delete && eligible.length) {
    // One SQL write for the entire page. No per-agent round trips, transaction
    // capability fallback, or gap between the final safety check and deletion.
    deleted = await db.all<{ id: string }>(sql`
      DELETE FROM agents AS a
      WHERE a.workspace_id = ${workspaceId}
        AND a.id IN (${sql.join(eligible.map(row => sql`${row.id}`), sql`, `)})
        AND ${reason(cutoff, indexesReady)} = 'eligible'
      RETURNING id`);
  }
  const counts: Record<Reason, number> = {
    not_offline: 0, recent_or_unknown: 0, ownership_protected: 0, history_unverified: 0, history_referenced: 0, eligible: 0,
  };
  for (const row of rows) counts[row.reason]++;
  const last = rows.at(-1)?.id;
  return {
    dry_run: !options.delete,
    cutoff: new Date(cutoff * 1000).toISOString(),
    scanned: rows.length,
    counts,
    candidates: eligible.map(({ id, name, last_seen }) => ({ id, name, last_seen })),
    deleted: deleted.length,
    skipped_changed: options.delete ? eligible.length - deleted.length : 0,
    next_cursor: rows.length === options.limit && last && last < through
      ? { workspace_id: workspaceId, cutoff, after: last, through }
      : null,
  };
}
