import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { reportEngineProgress } from '../lib/engineDiagnostics.js';

/**
 * Bounded deletion of one workspace's bulk rows, ahead of the final
 * `DELETE FROM workspaces` cascade.
 *
 * Deleting a workspace used to be ONE statement batch: the `workspaces` row's
 * ON DELETE CASCADE removed every message, delivery, log and event of the
 * tenant in a single transaction, firing per-row triggers (mention/search FTS,
 * file cleanup), retried up to five times on failure. On a shared D1 a large
 * tenant held the database for minutes — every other tenant's requests queued
 * behind it (`D1 DB is overloaded`). The reaper drained expired workspaces the
 * same way, including a background reap after every workspace creation.
 *
 * For a workspace above `WORKSPACE_ATOMIC_DELETE_MAX_ROWS`, the bulk tables are
 * drained first in small statements, each followed by an idle pause, so the
 * cleanup never takes more than a fixed share of database time and stops at a
 * wall-clock budget. Only once they are empty does the caller run the final
 * cascade, which then touches a small tenant. Smaller workspaces keep the
 * atomic single-transaction delete.
 *
 * Order matters: `messages.thread_id`, `messages.agent_id` and
 * `channels.created_by` are NO ACTION references, enforced per statement. So
 * messages are drained newest first (a reply is always newer than its root)
 * with the retention guard that never removes a root still holding replies;
 * agents and channels are left to the final cascade. Tables that cascade from
 * messages (deliveries, message_logs) are drained before them so each message
 * statement stays small.
 */
const DRAIN_TABLES: readonly {
  table: string;
  chunk: number;
  where?: string;
  order?: string;
}[] = [
  { table: 'deliveries', chunk: 500 },
  { table: 'message_logs', chunk: 500 },
  { table: 'workspace_events', chunk: 500 },
  { table: 'session_events', chunk: 500 },
  { table: 'action_invocations', chunk: 500 },
  { table: 'usage_records', chunk: 500 },
  // Cascades webhook_deliveries.
  { table: 'pending_events', chunk: 200 },
  // Cascades reactions, receipts, attachments; fires the FTS delete triggers.
  {
    table: 'messages',
    chunk: 200,
    where: 'NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = messages.id)',
    order: 'length(id) DESC, id DESC',
  },
];

/**
 * Bulk rows above which a workspace is too large to delete in one atomic
 * transaction. Below it, deletion keeps its atomic contract (all or nothing,
 * storage failures reported synchronously); above it, the workspace is
 * tombstoned and drained in bounded steps.
 */
export const WORKSPACE_ATOMIC_DELETE_MAX_ROWS = 2_000;

/**
 * True when the workspace holds more than `maxRows` bulk rows. Each probe is an
 * index range capped at the remaining allowance, so the check itself is
 * bounded no matter how large the tenant is.
 */
export async function exceedsAtomicDeleteSize(
  db: Db,
  workspaceId: string,
  maxRows = WORKSPACE_ATOMIC_DELETE_MAX_ROWS,
): Promise<boolean> {
  let seen = 0;
  for (const { table } of DRAIN_TABLES) {
    const [row] = await db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM (
        SELECT 1 FROM ${sql.raw(table)} WHERE workspace_id = ${workspaceId} LIMIT ${maxRows - seen + 1}
      )
    `);
    seen += Number(row?.n ?? 0);
    if (seen > maxRows) return true;
  }
  return false;
}

/** Default wall-clock budget for one drain call. */
export const WORKSPACE_DRAIN_MAX_DURATION_MS = 2_000;
/**
 * Fraction of wall time spent in drain statements; the rest is idle. At 0.5
 * every statement is followed by a pause as long as it took.
 */
export const WORKSPACE_DRAIN_DUTY_CYCLE = 0.5;

export interface WorkspaceDrainOptions {
  /** Absolute wall-clock deadline (ms since epoch); overrides maxDurationMs. */
  deadline?: number;
  maxDurationMs?: number;
  dutyCycle?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkspaceDrainResult {
  /** True when every bulk table is empty for this workspace. */
  complete: boolean;
  rows: number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function drainWorkspaceRows(
  db: Db,
  workspaceId: string,
  options: WorkspaceDrainOptions = {},
): Promise<WorkspaceDrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = options.deadline ?? now() + (options.maxDurationMs ?? WORKSPACE_DRAIN_MAX_DURATION_MS);
  const duty = Math.min(Math.max(options.dutyCycle ?? WORKSPACE_DRAIN_DUTY_CYCLE, 0.05), 1);
  let rows = 0;

  for (const { table, chunk, where, order } of DRAIN_TABLES) {
    for (;;) {
      if (now() >= deadline) return { complete: false, rows };
      const started = now();
      // Table and clause names are the constants above, never input.
      const deleted = await db.all(sql`
        DELETE FROM ${sql.raw(table)}
        WHERE rowid IN (
          SELECT rowid FROM ${sql.raw(table)}
          WHERE workspace_id = ${workspaceId}${where ? sql.raw(` AND ${where}`) : sql``}
          ${order ? sql.raw(`ORDER BY ${order}`) : sql``}
          LIMIT ${chunk}
        )
        RETURNING 1
      `);
      const elapsed = now() - started;
      rows += deleted.length;
      if (deleted.length > 0) {
        reportEngineProgress({
          operation: 'workspace.delete', workspaceId, phase: 'batch', table, rows: deleted.length,
          remaining: null, durationMs: elapsed,
        });
      }
      // A short page means this table is empty (or only guarded rows remain,
      // which the final cascade removes in one small statement).
      if (deleted.length < chunk) break;
      const idle = elapsed * (1 / duty - 1);
      if (idle > 0) await sleep(Math.min(idle, Math.max(0, deadline - now())));
    }
  }
  return { complete: true, rows };
}
