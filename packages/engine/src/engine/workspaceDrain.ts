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
 * with the retention guard that never removes a root still holding replies,
 * and agents go last, guarded against any remaining reference. Tables that
 * cascade from messages (deliveries, message_logs) are drained before them so
 * each message statement stays small.
 */
interface DrainStep {
  table: string;
  chunk: number;
  where?: string;
  order?: string;
  /**
   * Fan-out tables keyed by this one's `id` and without a `workspace_id` of
   * their own. Each round takes ONE bounded page of this table's ids, drains
   * those parents' children through the foreign-key index, then deletes that
   * same page, so neither a child query nor a parent cascade ever has to
   * search or remove more than one page's worth.
   */
  children?: readonly { table: string; key: string }[];
}

const CHILD_CHUNK = 500;

const DRAIN_STEPS: readonly DrainStep[] = [
  { table: 'deliveries', chunk: 500 },
  { table: 'message_logs', chunk: 500 },
  { table: 'workspace_events', chunk: 500 },
  { table: 'session_events', chunk: 500 },
  { table: 'action_invocations', chunk: 500 },
  { table: 'usage_records', chunk: 500 },
  // One webhook delivery per (event, matching subscription).
  { table: 'pending_events', chunk: 200, children: [{ table: 'webhook_deliveries', key: 'event_id' }] },
  // Per-message fan-out (one receipt per reader). Deleting a message fires
  // the FTS delete triggers.
  {
    table: 'messages',
    chunk: 200,
    where: 'NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = messages.id)',
    order: 'length(id) DESC, id DESC',
    children: [
      { table: 'read_receipts', key: 'message_id' },
      { table: 'reactions', key: 'message_id' },
      { table: 'message_attachments', key: 'message_id' },
    ],
  },
  // Each file row enqueues its blob in the durable cleanup outbox (trigger),
  // which the reaper drains.
  { table: 'files', chunk: 200 },
  { table: 'dm_conversations', chunk: 200, children: [{ table: 'dm_participants', key: 'conversation_id' }] },
  // Cascades webhooks.
  { table: 'channels', chunk: 200, children: [{ table: 'channel_members', key: 'channel_id' }] },
  // Last of the bulk tables: messages, channels and files are NO ACTION
  // references to agents, so an agent still referenced is left to the cascade.
  {
    table: 'agents',
    chunk: 200,
    where: [
      'NOT EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = agents.id)',
      'NOT EXISTS (SELECT 1 FROM channels c WHERE c.created_by = agents.id)',
      'NOT EXISTS (SELECT 1 FROM files f WHERE f.uploaded_by = agents.id)',
      'NOT EXISTS (SELECT 1 FROM webhooks w WHERE w.created_by = agents.id)',
    ].join(' AND '),
  },
  { table: 'nodes', chunk: 200 },
];

// Names below are the constants above, never input.

/**
 * One page of `step` in this workspace, as `column` values. The child deletes
 * and the parent delete of a round embed this exact subquery (ids are not
 * bound: a page would exceed D1's 100-parameter limit), so they see the same
 * rows. Its LIMIT bounds the parent search.
 */
function pageSql(step: DrainStep, workspaceId: string, column: 'id' | 'rowid', limit = step.chunk) {
  return sql`
    SELECT ${sql.raw(column)} FROM ${sql.raw(step.table)}
    WHERE workspace_id = ${workspaceId}${step.where ? sql.raw(` AND ${step.where}`) : sql``}
    ${step.order ? sql.raw(`ORDER BY ${step.order}`) : sql``}
    LIMIT ${limit}
  `;
}

function childPageSql(child: { table: string; key: string }, parentPage: ReturnType<typeof pageSql>, limit: number) {
  return sql`
    SELECT rowid FROM ${sql.raw(child.table)}
    WHERE ${sql.raw(child.key)} IN (${parentPage})
    LIMIT ${limit}
  `;
}

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
  const count = async (query: ReturnType<typeof sql>) => {
    const [row] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM (${query})`);
    seen += Number(row?.n ?? 0);
    return seen > maxRows;
  };
  for (const step of DRAIN_STEPS) {
    // Unguarded, unordered: the probe counts rows, it does not choose a page.
    const plain = { ...step, where: undefined, order: undefined };
    if (await count(pageSql(plain, workspaceId, 'rowid', maxRows - seen + 1))) return true;
    for (const child of step.children ?? []) {
      // Children of at most the first maxRows + 1 parents: if there are more
      // parents than that, the parent count above already decided.
      const parents = pageSql(plain, workspaceId, 'id', maxRows + 1);
      if (await count(childPageSql(child, parents, maxRows - seen + 1))) return true;
    }
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

  // One paced, deadline-checked statement. Returns rows deleted, or null when
  // the budget is spent before it could run.
  const run = async (table: string, rowids: ReturnType<typeof sql>): Promise<number | null> => {
    if (now() >= deadline) return null;
    const started = now();
    const deleted = await db.all(sql`DELETE FROM ${sql.raw(table)} WHERE rowid IN (${rowids}) RETURNING 1`);
    const elapsed = now() - started;
    rows += deleted.length;
    if (deleted.length > 0) {
      reportEngineProgress({
        operation: 'workspace.delete', workspaceId, phase: 'batch', table, rows: deleted.length,
        remaining: null, durationMs: elapsed,
      });
      // Every page that deleted rows is paced, a table's last one included.
      const idle = elapsed * (1 / duty - 1);
      if (idle > 0) await sleep(Math.min(idle, Math.max(0, deadline - now())));
    }
    return deleted.length;
  };

  for (const step of DRAIN_STEPS) {
    for (;;) {
      for (const child of step.children ?? []) {
        for (;;) {
          const deleted = await run(child.table, childPageSql(child, pageSql(step, workspaceId, 'id'), CHILD_CHUNK));
          if (deleted === null) return { complete: false, rows };
          if (deleted < CHILD_CHUNK) break;
        }
      }
      const deleted = step.children
        // The same page whose children were just drained.
        ? await run(step.table, sql`SELECT rowid FROM ${sql.raw(step.table)} WHERE id IN (${pageSql(step, workspaceId, 'id')})`)
        : await run(step.table, pageSql(step, workspaceId, 'rowid'));
      if (deleted === null) return { complete: false, rows };
      // A short page means this table is empty (or only guarded rows remain,
      // which the final cascade removes in one small statement).
      if (deleted < step.chunk) break;
    }
  }
  return { complete: true, rows };
}
