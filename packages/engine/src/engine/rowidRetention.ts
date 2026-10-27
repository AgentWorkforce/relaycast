import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EngineDb } from '../ports/database.js';
import type { WorkspaceRetentionSettings } from '../db/schema.js';
import type { PruneOptions, PruneResult, RetentionDefaults } from './retention.js';
import { snowflakeIdLowerBound } from './snowflake.js';

const safeRowid = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const stateSchema = z.object({
  version: z.literal(1),
  next: z.number().int().min(0).max(4),
  tables: z.record(z.string(), z.object({ cursor: safeRowid.optional(), high: safeRowid.optional() })),
});
export type RowidRetentionState = z.infer<typeof stateSchema>;

/**
 * Host-owned durable state for the schema-free retention path. Hosts must
 * serialize maintenance calls for a database, and `save` must resolve only
 * after the checkpoint is durable. This path creates no engine table or index.
 */
export interface RetentionCursorStore {
  load(): Promise<unknown>;
  save(state: RowidRetentionState): Promise<void>;
}

type Candidate = {
  _rowid: number;
  id: string;
  workspace_id: string;
  created_at: number;
  expires_at: number | null;
  seq: number;
  message_id: string;
  agent_id: string;
  status: string;
  retention: string | null;
  eligible: number;
};
type Table = {
  name: string;
  result: keyof PruneResult;
  columns: string;
  setting?: keyof WorkspaceRetentionSettings;
  fallback?: keyof RetentionDefaults;
  snowflake?: boolean;
  guard: string;
};

const SETTLED_DELIVERIES = "deliveries.status IN ('acked', 'failed', 'dead_lettered')";
const DEFAULT_EXPIRED_DELIVERY_GRACE_DAYS = 7;
const MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES = 4;
const ACTIVE_EXPIRY_RECOVERY_DELETE_LIMIT = 1_000;
const ROWID_PAGE_LIMIT = 200;
const ROWID_MAX_BATCHES_PER_TABLE = 5;
const ROWID_DELETE_CHUNK_SIZE = 10;

const tables: Table[] = [
  { name: 'messages', result: 'messages', columns: 'id, workspace_id',
    setting: 'message_ttl_days', fallback: 'messageTtlDays', snowflake: true,
    guard: 'NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = messages.id)' },
  { name: 'deliveries', result: 'deliveries', columns: 'id, workspace_id, created_at, status, expires_at',
    setting: 'delivery_ttl_days', fallback: 'deliveryTtlDays', guard: SETTLED_DELIVERIES },
  { name: 'message_logs', result: 'messageLogs', columns: 'id, workspace_id',
    setting: 'message_log_ttl_days', fallback: 'messageLogTtlDays', snowflake: true, guard: '1' },
  { name: 'workspace_events', result: 'workspaceEvents', columns: 'workspace_id, seq, created_at',
    setting: 'workspace_event_ttl_days', fallback: 'workspaceEventTtlDays',
    guard: 'EXISTS (SELECT 1 FROM workspace_events hw WHERE hw.workspace_id = workspace_events.workspace_id AND hw.seq > workspace_events.seq LIMIT 1)' },
  { name: 'read_receipts', result: 'readReceipts', columns: 'message_id, agent_id',
    guard: 'NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = read_receipts.message_id)' },
];

/** Worst-case statement count for one cursor-store invocation, below D1's 1000-query ceiling. */
export const ROWID_RETENTION_D1_QUERY_CEILING = tables.length * (
  1 + ROWID_MAX_BATCHES_PER_TABLE + ROWID_MAX_BATCHES_PER_TABLE * Math.ceil(ROWID_PAGE_LIMIT / ROWID_DELETE_CHUNK_SIZE)
) + MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES;

/** Delete only long-expired active deliveries through the existing bounded index. */
async function recoverExpiredActiveDeliveries(
  db: EngineDb,
  nowMs: number,
  graceDays: number,
  maxBatches: number,
): Promise<number> {
  const cutoffSeconds = Math.floor((nowMs - Math.max(0, Math.floor(graceDays * 86_400_000))) / 1_000);
  const batches = bounded(maxBatches, MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES, MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES);
  let deleted = 0;
  for (let batch = 0; batch < batches; batch++) {
    // This is the pre-existing global active-expiry index from migration 0031;
    // the outer predicate repeats every condition so extension/status races are safe.
    const changed = await db.all<{ id: string }>(sql`
      DELETE FROM deliveries
      WHERE status IN ('queued', 'delivered')
        AND expires_at IS NOT NULL AND expires_at < ${cutoffSeconds}
        AND id IN (
          SELECT id FROM deliveries INDEXED BY idx_deliveries_active_expiry
          WHERE status IN ('queued', 'delivered')
            AND expires_at IS NOT NULL AND expires_at < ${cutoffSeconds}
          ORDER BY expires_at, id LIMIT ${ACTIVE_EXPIRY_RECOVERY_DELETE_LIMIT}
        )
      RETURNING id
    `);
    deleted += changed.length;
    if (changed.length < ACTIVE_EXPIRY_RECOVERY_DELETE_LIMIT) break;
  }
  return deleted;
}

/** Clamp an optional maintenance budget to a positive, finite row count. */
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value)))
    : fallback;
}

/** Evaluate one candidate against its workspace retention policy and clock. */
function isExpired(row: Candidate, table: Table, defaults: Required<RetentionDefaults>, nowMs: number): boolean {
  if (!table.setting || !table.fallback) return true;
  const settings = row.retention ? JSON.parse(row.retention) as WorkspaceRetentionSettings : {};
  const days = settings[table.setting] === undefined ? defaults[table.fallback] : settings[table.setting];
  if (days == null || !Number.isFinite(days) || days <= 0) return false;
  const cutoff = nowMs - days * 86_400_000;
  if (!Number.isFinite(cutoff)) return false;
  if (!table.snowflake) return row.created_at * 1_000 < cutoff;
  const bound = snowflakeIdLowerBound(cutoff);
  return row.id.length < bound.length || (row.id.length === bound.length && row.id < bound);
}

/**
 * Schema-free recovery mode. It pages by SQLite rowid before policy and
 * eligibility filtering, so retained history cannot turn a bounded run into a
 * full scan. A saved high-water mark makes each traversal finite under writes.
 */
export async function pruneRowidPages(
  db: EngineDb,
  opts: PruneOptions & { cursorStore: RetentionCursorStore },
): Promise<PruneResult> {
  const nowMs = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid retention clock');
  const limit = bounded(opts.batchLimit, ROWID_PAGE_LIMIT, ROWID_PAGE_LIMIT);
  const pageBudget = bounded(opts.maxBatches, ROWID_MAX_BATCHES_PER_TABLE, ROWID_MAX_BATCHES_PER_TABLE) * tables.length;
  const deadline = Date.now() + bounded(opts.maxDurationMs, 10_000, 30_000);
  const defaults: Required<RetentionDefaults> = {
    messageTtlDays: null,
    deliveryTtlDays: 90,
    messageLogTtlDays: 90,
    workspaceEventTtlDays: 30,
    ...Object.fromEntries(Object.entries(opts.defaults ?? {}).filter(([, value]) => value !== undefined)),
  };
  const saved = await opts.cursorStore.load();
  // Cursor documents are advisory checkpoints owned by the host. A stale,
  // partial, or legacy document must not take scheduled retention offline, and
  // must never be trusted to construct a delete predicate. Restarting from an
  // empty state is safe because every delete below rechecks row identity and
  // current policy before mutating anything.
  const parsed = saved == null ? undefined : stateSchema.safeParse(saved);
  const state: RowidRetentionState = parsed?.success
    ? parsed.data
    : { version: 1, next: 0, tables: {} };
  const save = () => opts.cursorStore.save(structuredClone(state));
  const result: PruneResult = { messages: 0, deliveries: 0, messageLogs: 0, readReceipts: 0, workspaceEvents: 0 };
  const finished = new Set<number>();

  // Active expiry is opt-in because it intentionally skips delivery.failed
  // fanout; normal scheduled expiry remains the default notification path.
  if (opts.activeExpiryRecovery === true) {
    result.deliveries += await recoverExpiredActiveDeliveries(
      db,
      nowMs,
      opts.expiredDeliveryGraceDays ?? DEFAULT_EXPIRED_DELIVERY_GRACE_DAYS,
      opts.activeExpiryRecoveryMaxBatches ?? MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES,
    );
  }

  for (let step = 0; step < pageBudget && Date.now() < deadline; step++) {
    const index = state.next;
    state.next = (index + 1) % tables.length;
    if (finished.has(index)) continue;
    const table = tables[index]!;
    await save(); // fairness is durable before an admitted page
    const position = state.tables[table.name] ??= {};
    if (Date.now() >= deadline) break;
    if (position.high === undefined) {
      const [last] = await db.all<{ _rowid: number }>(sql`
        SELECT rowid AS _rowid FROM ${sql.raw(table.name)} NOT INDEXED ORDER BY rowid DESC LIMIT 1
      `);
      if (!last) {
        delete state.tables[table.name];
        finished.add(index);
        await save();
        continue;
      }
      position.high = safeRowid.parse(last._rowid);
    }
    if (Date.now() >= deadline) break;
    const page = await db.all<Candidate>(sql`
      WITH page AS MATERIALIZED (
        SELECT rowid AS _rowid, ${sql.raw(table.columns)} FROM ${sql.raw(table.name)} NOT INDEXED
        WHERE rowid <= ${position.high}
          ${position.cursor === undefined ? sql`` : sql`AND rowid > ${position.cursor}`}
        ORDER BY rowid LIMIT ${limit}
      ) SELECT page.*, ${sql.raw(table.guard.replaceAll(table.name + '.', 'page.'))} AS eligible,
        ${table.setting ? sql`w.retention` : sql`NULL`} AS retention
      FROM page ${table.setting ? sql`LEFT JOIN workspaces w ON w.id = page.workspace_id` : sql``}
      ORDER BY page._rowid
    `);
    for (const row of page) safeRowid.parse(row._rowid);
    const removable = page.filter(row => row.eligible && isExpired(row, table, defaults, nowMs));
    for (let offset = 0; offset < removable.length; offset += ROWID_DELETE_CHUNK_SIZE) {
      if (Date.now() >= deadline) {
        await save();
        return result;
      }
      const chunk = removable.slice(offset, offset + ROWID_DELETE_CHUNK_SIZE);
      const guards = chunk.map(row => {
        const identity = table.result === 'workspaceEvents'
          ? sql`workspace_id = ${row.workspace_id} AND seq = ${row.seq}`
          : table.result === 'readReceipts'
            ? sql`message_id = ${row.message_id} AND agent_id = ${row.agent_id}`
            : sql`id = ${row.id} AND workspace_id = ${row.workspace_id}`;
        const policy = table.setting ? sql`AND (SELECT retention FROM workspaces WHERE id = ${row.workspace_id}) IS ${row.retention}` : sql``;
        const created = table.setting && !table.snowflake ? sql`AND created_at = ${row.created_at}` : sql``;
        const status = table.result === 'deliveries' ? sql`AND status = ${row.status}` : sql``;
        return sql`(rowid = ${row._rowid} AND ${identity} ${policy} ${created} ${status})`;
      });
      const deleted = await db.all(sql`DELETE FROM ${sql.raw(table.name)} NOT INDEXED
        WHERE (${sql.join(guards, sql` OR `)}) AND ${sql.raw(table.guard)} RETURNING 1`);
      result[table.result] += deleted.length;
    }
    if (page.length < limit || page.at(-1)?._rowid === position.high) {
      delete state.tables[table.name];
      finished.add(index);
    } else {
      position.cursor = page.at(-1)!._rowid;
    }
    await save();
    if (finished.size === tables.length) break;
  }
  return result;
}
