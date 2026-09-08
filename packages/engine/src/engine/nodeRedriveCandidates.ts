import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EngineDb } from '../ports/database.js';

const position = z.union([
  z.tuple([z.number(), z.string()]),
  z.tuple([z.number(), z.number(), z.string()]),
]);
const cursorSchema = z.object({ after: position.optional(), high: position.optional() });
type Candidate = { id: string; created_at: number; next_attempt_at: number | null; expires_at: number | null };

/**
 * Examine one indexed metadata window before applying expiry or hydrating.
 * Persist its keyset position even for an expired-only window. A short/empty
 * result is not proof that the queue is empty: the next scheduled sweep resumes.
 * The fixed high-water fence guarantees wraparound under continuous arrivals.
 * Cursors are advisory: retries/crashes may repeat work, never acknowledge it.
 */
export async function readNodeRedriveCandidates(
  db: EngineDb,
  opts: { workspaceId?: string; retry: boolean; limit: number; nowSeconds: number },
): Promise<string[]> {
  const lane = opts.retry ? 'retry' : 'initial';
  const cursorId = JSON.stringify(['node-redrive-v1', opts.workspaceId ?? null, lane]);
  const [saved] = await db.all<{ cursor: string }>(sql`SELECT cursor FROM maintenance_cursors WHERE id = ${cursorId}`);
  let cursor: z.infer<typeof cursorSchema> = {};
  try {
    const parsed = cursorSchema.safeParse(saved ? JSON.parse(saved.cursor) : {});
    if (parsed.success) cursor = parsed.data;
  } catch { /* A damaged advisory cursor safely restarts traversal. */ }
  const keys = opts.retry ? ['next_attempt_at', 'created_at', 'id'] : ['created_at', 'id'];
  const key = (row: Candidate): z.infer<typeof position> => opts.retry
    ? [row.next_attempt_at!, row.created_at, row.id] : [row.created_at, row.id];
  const index = 'idx_deliveries_node_' + lane + (opts.workspaceId === undefined ? '' : '_workspace');
  // Literal predicates match the partial indexes; other route kinds never
  // enter the scan, and the workspace variant seeks past other tenants.
  const conditions = [sql.raw(`status = 'queued'
    AND route_node_kind IN ('http_push', 'ws', 'fleet_ws', 'direct_ws')
    AND next_attempt_at IS ${opts.retry ? 'NOT NULL' : 'NULL'}`)];
  if (opts.workspaceId !== undefined) conditions.push(sql`workspace_id = ${opts.workspaceId}`);
  if (opts.retry) conditions.push(sql`next_attempt_at <= ${opts.nowSeconds}`);
  if (!cursor.high || cursor.high.length !== keys.length) {
    cursor = {};
    const [last] = await db.all<Candidate>(sql`
      SELECT id, created_at, next_attempt_at, expires_at
      FROM deliveries INDEXED BY ${sql.raw(index)}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${sql.raw(keys.map(k => k + ' DESC').join(', '))} LIMIT 1
    `);
    if (last) cursor.high = key(last);
  }
  if (cursor.after?.length === keys.length) {
    conditions.push(sql`(${sql.raw(keys.join(', '))}) > (${sql.join(cursor.after.map(v => sql`${v}`), sql`, `)})`);
  }
  if (cursor.high) {
    conditions.push(sql`(${sql.raw(keys.join(', '))}) <= (${sql.join(cursor.high.map(v => sql`${v}`), sql`, `)})`);
  }
  const page = await db.all<Candidate>(sql`
    SELECT id, created_at, next_attempt_at, expires_at
    FROM deliveries INDEXED BY ${sql.raw(index)}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${sql.raw(keys.join(', '))} LIMIT ${opts.limit}
  `);
  if (page.length < opts.limit || JSON.stringify(key(page[page.length - 1]!)) === JSON.stringify(cursor.high)) {
    cursor = {};
  } else {
    cursor.after = key(page[page.length - 1]!);
  }
  await db.run(sql`INSERT INTO maintenance_cursors(id, cursor) VALUES (${cursorId}, ${JSON.stringify(cursor)})
    ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor`);
  return page.filter(row => row.expires_at === null || row.expires_at > opts.nowSeconds).map(row => row.id);
}
