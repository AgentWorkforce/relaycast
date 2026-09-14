import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { EngineDb } from '../ports/database.js';
import type { WorkspaceRetentionSettings } from '../db/schema.js';
import type { PruneOptions, PruneResult, RetentionDefaults } from './retention.js';
import { snowflakeIdLowerBound } from './snowflake.js';

const DAY_MS = 86_400_000;
const position = z.array(z.union([z.string(), z.number()]));
const stateSchema = z.object({
  next: z.number().int().min(0).max(4),
  positions: z.record(z.string(), position),
  highs: z.record(z.string(), position).default({}),
});
type State = z.infer<typeof stateSchema>;
type Candidate = {
  id: string;
  workspace_id: string;
  created_at: number;
  expires_at: number | null;
  seq: number;
  message_id: string;
  agent_id: string;
  retention: string | null;
  eligible: number;
};
type Table = {
  result: keyof PruneResult;
  name: string;
  index: string;
  keys: string[];
  setting?: keyof WorkspaceRetentionSettings;
  fallback?: keyof RetentionDefaults;
  predicate?: string;
  eligible?: string;
};
const tables: Table[] = [
  { result: 'messages', name: 'messages', index: 'idx_messages_retention',
    keys: ['length(id)', 'id'], setting: 'message_ttl_days', fallback: 'messageTtlDays',
    eligible: 'NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = page.id)' },
  { result: 'deliveries', name: 'deliveries', index: 'idx_deliveries_settled_retention',
    keys: ['created_at', 'id'], setting: 'delivery_ttl_days', fallback: 'deliveryTtlDays',
    predicate: "status IN ('acked', 'failed', 'dead_lettered')" },
  { result: 'expiredDeliveries', name: 'deliveries', index: 'idx_deliveries_active_expiry',
    keys: ['expires_at', 'id'],
    predicate: "status IN ('queued', 'delivered') AND expires_at IS NOT NULL" },
  { result: 'messageLogs', name: 'message_logs', index: 'idx_message_logs_retention',
    keys: ['length(id)', 'id'], setting: 'message_log_ttl_days', fallback: 'messageLogTtlDays' },
  { result: 'workspaceEvents', name: 'workspace_events', index: 'idx_workspace_events_retention',
    keys: ['created_at', 'workspace_id', 'seq'], setting: 'workspace_event_ttl_days',
    fallback: 'workspaceEventTtlDays',
    eligible: 'EXISTS (SELECT 1 FROM workspace_events hw WHERE hw.workspace_id = page.workspace_id AND hw.seq > page.seq LIMIT 1)' },
  { result: 'readReceipts', name: 'read_receipts', index: 'idx_read_receipts_retention',
    keys: ['message_id', 'agent_id'],
    eligible: 'NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = page.message_id)' },
];

/** Project a candidate onto its table's ordered keyset cursor. */
function key(row: Candidate, table: Table): (string | number)[] {
  return table.keys.map(k => {
    if (k === 'length(id)') return row.id.length;
    return row[k as keyof Candidate] as string | number;
  });
}

/** Apply exact workspace policy after the bounded candidate read. */
function expired(
  row: Candidate,
  table: Table,
  defaults: Required<RetentionDefaults>,
  nowMs: number,
  expiredDeliveryGraceDays: number,
): boolean {
  if (!row.eligible) return false;
  if (!table.setting || !table.fallback) return true;
  if (table.result === 'expiredDeliveries') {
    const graceMs = Math.max(0, Math.floor(expiredDeliveryGraceDays * DAY_MS));
    // expires_at is stored as a unix timestamp (seconds), so multiply by 1000.
    if (row.expires_at == null) return false;
    return row.expires_at * 1000 < nowMs - graceMs;
  }
  const settings = row.retention ? JSON.parse(row.retention) as WorkspaceRetentionSettings : {};
  const override = settings[table.setting];
  const ttl = override === undefined ? defaults[table.fallback] : override;
  if (ttl == null || !Number.isFinite(ttl) || ttl <= 0) return false;
  const cutoff = nowMs - ttl * DAY_MS;
  if (table.keys[0] === 'length(id)') {
    const bound = snowflakeIdLowerBound(cutoff);
    return row.id.length < bound.length || (row.id.length === bound.length && row.id < bound);
  }
  return row.created_at * 1000 < cutoff;
}

/** Construct a bound primary-key predicate without interpolating user SQL. */
function identity(row: Candidate, table: Table): SQL {
  if (table.result === 'workspaceEvents') return sql`(workspace_id = ${row.workspace_id} AND seq = ${row.seq})`;
  if (table.result === 'readReceipts') return sql`(message_id = ${row.message_id} AND agent_id = ${row.agent_id})`;
  return sql`id = ${row.id}`;
}

/**
 * Bound candidate reads, not just returned/deleted rows. Persist progress even
 * when a page contains only retained rows, so disabled TTLs, live receipts and
 * event high-water marks cannot pin a scan to the beginning forever.
 *
 * Each table completes at most one traversal per run; cursors wrap at EOF.
 * Cursor commits follow successful deletion. A crash can replay a page (safe),
 * never skip an uncommitted deletion. Hosts should serialize maintenance runs.
 */
export async function pruneBounded(db: EngineDb, opts: PruneOptions): Promise<PruneResult> {
  const limit = boundedInteger(opts.batchLimit, 200, 200);
  const rounds = boundedInteger(opts.maxBatches, 5, 5);
  const started = Date.now();
  const budget = boundedInteger(opts.maxDurationMs, 10_000, 30_000);
  const nowMs = (opts.now ?? new Date()).getTime();
  const expiredDeliveryGraceDays = opts.expiredDeliveryGraceDays ?? 7;
  const defaults: Required<RetentionDefaults> = {
    messageTtlDays: null, deliveryTtlDays: 90, messageLogTtlDays: 90, workspaceEventTtlDays: 30,
    ...Object.fromEntries(Object.entries(opts.defaults ?? {}).filter(([, value]) => value !== undefined)),
  };
  // One small policy aggregate (no workspace-ID bind list), not one history
  // scan per workspace. The shortest positive TTL provides a safe global index
  // cutoff; exact per-workspace policy is still checked on each candidate.
  // This avoids walking millions of recent rows that no policy can expire.
  const ttlTables = tables.filter(table => table.setting);
  const [minimums] = await db.all<Record<string, number | null>>(sql`SELECT
    ${sql.join(ttlTables.map(table => sql.raw(
      `MIN(CASE WHEN json_extract(retention, '$.${table.setting}') > 0 THEN json_extract(retention, '$.${table.setting}') END) AS "${table.result}"`,
    )), sql`, `)} FROM workspaces`);
  if (!Number.isFinite(nowMs) && [
    ...Object.values(defaults), ...Object.values(minimums ?? {}),
  ].some(ttl => typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0)) {
    throw new Error('Invalid retention clock: expected a finite Date when a positive TTL is active');
  }
  const saved = await db.all<{ cursor: string }>(sql`SELECT cursor FROM maintenance_cursors WHERE id = 'retention-v1'`);
  const parsed = saved[0] ? stateSchema.safeParse(decodeCursor(saved[0].cursor)) : undefined;
  const state: State = parsed?.success ? parsed.data : { next: 0, positions: {}, highs: {} };
  const result: PruneResult = { messages: 0, deliveries: 0, expiredDeliveries: 0, messageLogs: 0, readReceipts: 0, workspaceEvents: 0 };
  const finished = new Set<number>();
  for (let step = 0; step < rounds * tables.length && Date.now() - started < budget; step++) {
    const index = state.next;
    state.next = (index + 1) % tables.length;
    if (finished.has(index)) continue;
    const table = tables[index]!;
    const cursor = state.positions[table.name];
    const positiveTtls = table.fallback
      ? [defaults[table.fallback], minimums?.[table.result]].filter((ttl): ttl is number =>
        typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0)
      : [];
    if (table.fallback && !positiveTtls.length) {
      delete state.positions[table.name];
      delete state.highs[table.name];
      finished.add(index);
      await db.run(sql`INSERT INTO maintenance_cursors (id, cursor) VALUES ('retention-v1', ${JSON.stringify(state)})
        ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor`);
      continue;
    }
    const columns = sql.raw(table.result === 'readReceipts' ? 'message_id, agent_id'
      : table.result === 'workspaceEvents' ? 'workspace_id, seq, created_at'
      : table.result === 'expiredDeliveries' ? 'id, workspace_id, created_at, expires_at'
        : 'id, workspace_id, created_at');
    // A traversal has a finite end even while new rows keep arriving. Without
    // this fence the cursor might never wrap to retained rows that later age out.
    if (!state.highs[table.name]) {
      const [last] = await db.all<Candidate>(sql`SELECT ${columns}
        FROM ${sql.raw(table.name)} INDEXED BY ${sql.raw(table.index)}
        ${table.predicate ? sql`WHERE ${sql.raw(table.predicate)}` : sql``}
        ORDER BY ${sql.raw(table.keys.map(k => k + ' DESC').join(', '))} LIMIT 1`);
      if (last) state.highs[table.name] = key(last, table);
    }
    const predicates: SQL[] = [];
    if (table.predicate) predicates.push(sql.raw(table.predicate));
    if (table.fallback) {
      const cutoff = nowMs - Math.min(...positiveTtls) * DAY_MS;
      if (table.keys[0] === 'length(id)') {
        const bound = snowflakeIdLowerBound(cutoff);
        predicates.push(sql`(length(id), id) < (${bound.length}, ${bound})`);
      } else {
        predicates.push(sql`created_at < ${Math.ceil(cutoff / 1000)}`);
      }
    }
    if (cursor?.length === table.keys.length) {
      predicates.push(sql`(${sql.raw(table.keys.join(', '))}) > (${sql.join(cursor.map(v => sql`${v}`), sql`, `)})`);
    }
    const high = state.highs[table.name];
    if (high?.length === table.keys.length) {
      predicates.push(sql`(${sql.raw(table.keys.join(', '))}) <= (${sql.join(high.map(v => sql`${v}`), sql`, `)})`);
    }
    // MATERIALIZED prevents the planner pushing eligibility/TTL checks ahead
    // of LIMIT. The keyset seek and covering index bound candidate traversal.
    const page = await db.all<Candidate>(sql`
      WITH page AS MATERIALIZED (
        SELECT ${columns}
        FROM ${sql.raw(table.name)} INDEXED BY ${sql.raw(table.index)}
        ${predicates.length ? sql`WHERE ${sql.join(predicates, sql` AND `)}` : sql``}
        ORDER BY ${sql.raw(table.keys.join(', '))} LIMIT ${limit}
      )
      SELECT page.*, ${sql.raw(table.eligible ?? '1')} AS eligible,
        ${table.setting ? sql`w.retention` : sql`NULL`} AS retention
      FROM page
      ${table.setting ? sql`LEFT JOIN workspaces w ON w.id = page.workspace_id` : sql``}
      ORDER BY ${sql.raw(table.keys.map(k => k === 'length(id)' ? 'length(page.id)' : 'page.' + k).join(', '))}
    `);
    const removable = page.filter(row => expired(row, table, defaults, nowMs, expiredDeliveryGraceDays));
    // Two-key identities need two bindings each; leave room under D1's 100.
    for (let offset = 0; offset < removable.length; offset += 40) {
      const chunk = removable.slice(offset, offset + 40);
      const guard = table.result === 'messages'
        ? sql`AND NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = messages.id)`
        : table.result === 'readReceipts'
          ? sql`AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = read_receipts.message_id)`
        : table.result === 'workspaceEvents'
          ? sql`AND EXISTS (SELECT 1 FROM workspace_events hw WHERE hw.workspace_id = workspace_events.workspace_id AND hw.seq > workspace_events.seq LIMIT 1)`
        : table.predicate ? sql`AND ${sql.raw(table.predicate)}` : sql``;
      const deleted = await db.all(sql`DELETE FROM ${sql.raw(table.name)}
        WHERE (${sql.join(chunk.map(row => identity(row, table)), sql` OR `)}) ${guard}
        RETURNING 1`);
      result[table.result] += deleted.length;
    }
    if (page.length < limit || JSON.stringify(key(page[page.length - 1]!, table)) === JSON.stringify(high)) {
      delete state.positions[table.name];
      delete state.highs[table.name];
      finished.add(index);
    } else {
      state.positions[table.name] = key(page[page.length - 1]!, table);
    }
    await db.run(sql`INSERT INTO maintenance_cursors (id, cursor) VALUES ('retention-v1', ${JSON.stringify(state)})
      ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor`);
    if (finished.size === tables.length) break;
  }
  return result;
}

/** Decode advisory scan state; corrupt text restarts a safe traversal. */
function decodeCursor(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Clamp caller tuning to the supported finite maintenance budget. */
function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}
