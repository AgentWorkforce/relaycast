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

/** Host-owned durable state; the host MUST serialize callers for this database.
 * save resolves only after persistence. No new engine table/index is required.
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
const settled = "deliveries.status IN ('acked', 'failed', 'dead_lettered')";
// Table-qualified: `workspaces` also has an `expires_at`, and the outer page
// query joins it, so a bare column is ambiguous there. The page builder rewrites
// `deliveries.` to `page.` for the SELECT and leaves it intact for the DELETE.
const DEFAULT_EXPIRED_DELIVERY_GRACE_DAYS = 7;
function buildTables(_opts: { activeExpiryRecovery: boolean }) : Table[] {
  // Deliveries deletion in cursor mode is settled-only by default.
  // Active queued/delivered cleanup (after grace) is opt-in and handled
  // exclusively by the set-based recovery path.
  const reapableDeliveries = settled;
  return [
    { name: 'messages', result: 'messages', columns: 'id, workspace_id',
      setting: 'message_ttl_days', fallback: 'messageTtlDays', snowflake: true,
      guard: 'NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = messages.id)' },
    { name: 'deliveries', result: 'deliveries', columns: 'id, workspace_id, created_at, status, expires_at',
      setting: 'delivery_ttl_days', fallback: 'deliveryTtlDays', guard: reapableDeliveries },
    { name: 'message_logs', result: 'messageLogs', columns: 'id, workspace_id',
      setting: 'message_log_ttl_days', fallback: 'messageLogTtlDays', snowflake: true, guard: '1' },
    { name: 'workspace_events', result: 'workspaceEvents', columns: 'workspace_id, seq, created_at',
      setting: 'workspace_event_ttl_days', fallback: 'workspaceEventTtlDays',
      guard: 'EXISTS (SELECT 1 FROM workspace_events hw WHERE hw.workspace_id = workspace_events.workspace_id AND hw.seq > workspace_events.seq LIMIT 1)' },
    { name: 'read_receipts', result: 'readReceipts', columns: 'message_id, agent_id',
      guard: 'NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = read_receipts.message_id)' },
  ];
}

const MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES = 4;
const ACTIVE_EXPIRY_RECOVERY_DELETE_LIMIT = 1000;

async function recoverExpiredActiveDeliveriesSetBased(
  db: EngineDb,
  nowMs: number,
  graceDays: number,
  opts: { maxBatches: number },
): Promise<number> {
  const graceMs = Math.max(0, Math.floor(graceDays * 86_400_000));
  const cutoffMs = nowMs - graceMs;
  const cutoffSeconds = Math.floor(cutoffMs / 1000);

  // Use the existing index that already narrows to only active (queued/delivered).
  // We still re-check queued/delivered + expires_at in the outer DELETE predicate
  // to avoid expiry-extension races between selecting candidate ids and deleting.
  const batches = Math.max(1, Math.min(Math.floor(opts.maxBatches), MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES));
  let deleted = 0;
  for (let batch = 0; batch < batches; batch++) {
    const changed = await db.all<{ _id: string }>(sql`
      DELETE FROM deliveries
      WHERE (
        status IN ('queued', 'delivered')
        AND expires_at IS NOT NULL
        AND expires_at < ${cutoffSeconds}
      )
      AND id IN (
        SELECT id
        FROM deliveries INDEXED BY idx_deliveries_active_expiry
        WHERE status IN ('queued', 'delivered')
          AND expires_at IS NOT NULL
          AND expires_at < ${cutoffSeconds}
        ORDER BY expires_at, id
        LIMIT ${ACTIVE_EXPIRY_RECOVERY_DELETE_LIMIT}
      )
      RETURNING id AS _id
    `);
    deleted += changed.length;
    if (changed.length < ACTIVE_EXPIRY_RECOVERY_DELETE_LIMIT) break;
  }
  return deleted;
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

function expired(
  row: Candidate, table: Table, defaults: Required<RetentionDefaults>, now: number,
  expiredDeliveryGraceDays: number,
): boolean {
  // Active deliveries are judged on their own expiry, not on a workspace TTL:
  // no `delivery_ttl_days` value can express "this queued row is dead". Checked
  // before the `!table.setting` fallthrough below, which returns true
  // unconditionally and would otherwise delete live, unexpired deliveries.
  if (table.result === 'deliveries' && (row.status === 'queued' || row.status === 'delivered')) {
    if (row.expires_at == null) return false;
    const grace = Math.max(0, Math.floor(expiredDeliveryGraceDays * 86_400_000));
    return row.expires_at * 1000 < now - grace;
  }
  if (!table.setting || !table.fallback) return true;
  const settings = row.retention ? JSON.parse(row.retention) as WorkspaceRetentionSettings : {};
  const override = settings?.[table.setting];
  const days = override === undefined ? defaults[table.fallback] : override;
  if (days == null || !Number.isFinite(days) || days <= 0) return false;
  const cutoff = now - days * 86_400_000;
  if (!Number.isFinite(cutoff)) return false;
  if (!table.snowflake) return row.created_at * 1000 < cutoff;
  const bound = snowflakeIdLowerBound(cutoff);
  return row.id.length < bound.length || (row.id.length === bound.length && row.id < bound);
}

/**
 * Schema-free recovery mode. Rowid keyset pages bound candidate READS even when
 * no history is expired. TTLs/eligibility are applied AFTER the materialized
 * page, so LIMIT cannot hide a full-history scan. This deliberately trades scan
 * throughput for predictable candidate work while compact indexes are blocked.
 *
 * Rowid high-water makes each traversal finite under new writes. Retained rows
 * are revisited after wrap. Fairness is persisted before a page; its cursor only
 * moves after all admitted deletes settle. Failures replay a page, never skip
 * uncommitted rows. Message DELETE cascades may still be large; this is NOT a
 * bound on cascade writes or a replacement for per-tenant database isolation.
 */
export async function pruneRowidPages(db: EngineDb, opts: PruneOptions & { cursorStore: RetentionCursorStore }): Promise<PruneResult> {
  const now = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) throw new Error('Invalid retention clock');
  // Preserve existing cursor-mode ceilings exactly: 200 rows/page and 5
  // batches/table.
  const activeExpiryRecovery = opts.activeExpiryRecovery === true;
  const tables = buildTables({ activeExpiryRecovery });

  const limit = bounded(opts.batchLimit, 200, 200);
  const pages = bounded(opts.maxBatches, 5, 5) * tables.length;
  const deadline = Date.now() + bounded(opts.maxDurationMs, 10_000, 30_000);
  const defaults: Required<RetentionDefaults> = {
    messageTtlDays: null, deliveryTtlDays: 90, messageLogTtlDays: 90, workspaceEventTtlDays: 30,
    ...Object.fromEntries(Object.entries(opts.defaults ?? {}).filter(([, value]) => value !== undefined)),
  };
  const grace = opts.expiredDeliveryGraceDays ?? DEFAULT_EXPIRED_DELIVERY_GRACE_DAYS;
  const saved = await opts.cursorStore.load();
  // Corrupt state is an error, not permission to restart expensive work or
  // drop an unknown future cursor format during a rollback.
  const state: RowidRetentionState = saved == null
    ? { version: 1, next: 0, tables: {} } : stateSchema.parse(saved);
  const save = () => opts.cursorStore.save(structuredClone(state));
  const result: PruneResult = { messages: 0, deliveries: 0, messageLogs: 0, readReceipts: 0, workspaceEvents: 0 };
  const finished = new Set<number>();

  // Opt-in active expiry recovery BEFORE the rowid crawl so a slow scan
  // cannot starve active cleanup.
  if (activeExpiryRecovery) {
    const maxBatches = bounded(opts.activeExpiryRecoveryMaxBatches, MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES, MAX_ACTIVE_EXPIRY_RECOVERY_BATCHES);
    result.deliveries += await recoverExpiredActiveDeliveriesSetBased(
      db,
      now,
      grace,
      { maxBatches },
    );
  }
  for (let step = 0; step < pages && Date.now() < deadline; step++) {
    const index = state.next;
    state.next = (index + 1) % tables.length;
    if (finished.has(index)) continue;
    const table = tables[index]!;
    await save();
    const position = state.tables[table.name] ??= {};
    if (Date.now() >= deadline) break;
    if (position.high === undefined) {
      const [last] = await db.all<{ _rowid: number }>(sql`SELECT rowid AS _rowid FROM ${sql.raw(table.name)} NOT INDEXED ORDER BY rowid DESC LIMIT 1`);
      if (!last) { delete state.tables[table.name]; finished.add(index); await save(); continue; }
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
        ${table.setting ? sql`w.retention` : sql`NULL`} AS retention FROM page
      ${table.setting ? sql`LEFT JOIN workspaces w ON w.id = page.workspace_id` : sql``}
      ORDER BY page._rowid`);
    for (const row of page) safeRowid.parse(row._rowid);
    // Keep exact row identities alongside rowid: SQLite may reuse a deleted
    // rowid between the candidate read and a later DELETE.
      const removable = page.filter(row => row.eligible && expired(row, table, defaults, now, grace));
    // At most seven bindings per row, kept below D1's 100-variable limit.
    // Small atomic chunks also avoid one subrequest per retained-history row.
    for (let offset = 0; offset < removable.length; offset += 10) {
      if (Date.now() >= deadline) { await save(); return result; }
      const chunk = removable.slice(offset, offset + 10);
      const guarded = chunk.map(row => {
        const identity = table.result === 'workspaceEvents'
          ? sql`workspace_id = ${row.workspace_id} AND seq = ${row.seq}`
          : table.result === 'readReceipts'
            ? sql`message_id = ${row.message_id} AND agent_id = ${row.agent_id}`
            : sql`id = ${row.id} AND workspace_id = ${row.workspace_id}`;
        // A policy edit after the read must not authorize a stale deletion.
        // Exact raw-policy comparison is conservative (even whitespace edits
        // defer the row to the next traversal), and uses the workspace PK.
        // A missing workspace also has the default policy. workspace_events
        // intentionally has no workspace FK, so its orphan rows must age out.
        // The scalar PK lookup returns NULL for absence, but a newly installed
        // non-default policy still prevents deletion from the stale snapshot.
        const policyGuard = table.setting ? sql`AND (SELECT w.retention FROM workspaces w
          WHERE w.id = ${row.workspace_id}) IS ${row.retention}` : sql``;
        const timeGuard = table.setting && !table.snowflake ? sql`AND created_at = ${row.created_at}` : sql``;
        // The deliveries page is guarded as settled-only (default cursor mode),
        // but the opt-in active recovery path re-checks status/expiry again.
        // Always pin the exact status read so concurrent status changes
        // cannot authorize a stale deletion.
        const statusGuard = table.result === 'deliveries' ? sql`AND status = ${row.status}` : sql``;
        return sql`(rowid = ${row._rowid} AND ${identity} ${policyGuard} ${timeGuard} ${statusGuard})`;
      });
      const deleted = await db.all(sql`DELETE FROM ${sql.raw(table.name)} NOT INDEXED
        WHERE (${sql.join(guarded, sql` OR `)}) AND ${sql.raw(table.guard)} RETURNING 1`);
      result[table.result] += deleted.length;
    }
    if (page.length < limit || page.at(-1)?._rowid === position.high) {
      delete state.tables[table.name]; finished.add(index);
    } else position.cursor = page.at(-1)!._rowid;
    await save();
    if (finished.size === tables.length) break;
  }

  return result;
}
