import { and, eq, inArray, isNotNull, isNull, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { getDb } from '../db/index.js';
import {
  deliveries,
  messageLogs,
  messages,
  readReceipts,
  workspaceEvents,
  workspaces,
  type WorkspaceRetentionSettings,
} from '../db/schema.js';
import { snowflakeIdLowerBound } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Settled deliveries are operational tracking rows, pruned after 90 days by default. */
export const DEFAULT_DELIVERY_TTL_DAYS = 90;
/** Message logs are operational telemetry (duplicate bodies), pruned after 90 days by default. */
export const DEFAULT_MESSAGE_LOG_TTL_DAYS = 90;
/** Workspace event log rows are a reconciliation window, pruned after 30 days by default. */
export const DEFAULT_WORKSPACE_EVENT_TTL_DAYS = 30;

const DEFAULT_BATCH_LIMIT = 200;
const DEFAULT_MAX_BATCHES = 5;

/**
 * Delivery statuses that are terminal — the row is only kept as history.
 * Mirrors the engine's settled set (delivery.ts): `acked` (recipient
 * acknowledged), `dead_lettered` (TTL expiry), and `failed`. NOTE: `delivered`
 * is NOT terminal under the durable-mailbox model — it means "sent to the
 * current location, awaiting cumulative ack" (in-flight), so it must never be
 * pruned here; only `acked` is terminal success.
 */
const SETTLED_DELIVERY_STATUSES = ['acked', 'failed', 'dead_lettered'];

/**
 * Deployment-wide TTL fallbacks, applied to workspaces without their own
 * `workspaces.retention` settings. `null` disables pruning for that table.
 */
export interface RetentionDefaults {
  /** Messages are user data: no default — pruning is opt-in per workspace. */
  messageTtlDays?: number | null;
  /** Default {@link DEFAULT_DELIVERY_TTL_DAYS}. */
  deliveryTtlDays?: number | null;
  /** Default {@link DEFAULT_MESSAGE_LOG_TTL_DAYS}. */
  messageLogTtlDays?: number | null;
  /** Default {@link DEFAULT_WORKSPACE_EVENT_TTL_DAYS}. */
  workspaceEventTtlDays?: number | null;
}

export interface PruneOptions {
  /** Max rows deleted per table per batch (the SQL LIMIT). Default 200. */
  batchLimit?: number;
  /** Max batches per table per call, bounding total work per run. Default 5. */
  maxBatches?: number;
  /** Clock override for tests. */
  now?: Date;
  /** Deployment-wide TTL fallbacks; see {@link RetentionDefaults}. */
  defaults?: RetentionDefaults;
}

/** Rows deleted per table by a {@link pruneExpired} run. */
export interface PruneResult {
  messages: number;
  deliveries: number;
  messageLogs: number;
  readReceipts: number;
  workspaceEvents: number;
}

/**
 * `column < snowflakeIdLowerBound(cutoff)` compared numerically.
 *
 * Snowflake IDs are stored as decimal TEXT without leading zeros, and their
 * digit count grows over time — plain lexicographic `<` would mis-order a
 * short (older) ID against a longer bound. For non-negative decimals without
 * leading zeros, "shorter string" implies "smaller number", so length-then-lex
 * comparison is numerically exact.
 */
function olderThanSnowflake(column: SQLiteColumn, cutoffMs: number): SQL {
  const bound = snowflakeIdLowerBound(cutoffMs);
  return sql`(length(${column}) < ${bound.length} OR (length(${column}) = ${bound.length} AND ${column} < ${bound}))`;
}

interface PrunePass {
  cutoff: Date;
  /** Workspace predicate, or undefined for the unscoped default pass. */
  scope: SQL | undefined;
}

/**
 * Delete expired rows in bounded batches.
 *
 * Per-workspace TTLs come from `workspaces.retention` (see
 * {@link WorkspaceRetentionSettings}); workspaces without settings inherit
 * `opts.defaults`. Out of the box only operational tables are pruned
 * (settled `deliveries` and `message_logs`, 90 days); `messages` retention is
 * strictly opt-in — no workspace loses message history unless its settings
 * (or an explicit deployment default) say so.
 *
 * What a run does, per table, oldest rows first:
 * - `messages` older than the effective TTL, leaf-first: a message still
 *   referenced as a `thread_id` parent is skipped until its replies age out,
 *   so the self-referencing FK never breaks mid-batch. Cascades take the
 *   message's receipts, reactions, attachments, deliveries, and log row.
 * - settled `deliveries` (`acked`/`failed`/`dead_lettered`) older than the
 *   effective TTL. In-flight rows (`queued`/`delivered`) are never touched.
 * - `message_logs` older than the effective TTL.
 * - `read_receipts` whose message no longer exists (defensive sweep for rows
 *   written while FK enforcement was off).
 *
 * Every DELETE is a single `id IN (SELECT ... LIMIT n)` statement, capped at
 * `batchLimit` rows and `maxBatches` passes per table, so a run is always
 * short-lived and D1-friendly. Callers run it on a cadence (the Node adapter's
 * outbox cleanup tick, or a cloud scheduled handler) and backlogs drain over
 * successive runs.
 */
export async function pruneExpired(db: Db, opts: PruneOptions = {}): Promise<PruneResult> {
  const now = opts.now ?? new Date();
  const batchLimit = Math.max(1, opts.batchLimit ?? DEFAULT_BATCH_LIMIT);
  const maxBatches = Math.max(1, opts.maxBatches ?? DEFAULT_MAX_BATCHES);
  const defaults: Required<RetentionDefaults> = {
    messageTtlDays: opts.defaults?.messageTtlDays ?? null,
    deliveryTtlDays:
      opts.defaults?.deliveryTtlDays !== undefined
        ? opts.defaults.deliveryTtlDays
        : DEFAULT_DELIVERY_TTL_DAYS,
    messageLogTtlDays:
      opts.defaults?.messageLogTtlDays !== undefined
        ? opts.defaults.messageLogTtlDays
        : DEFAULT_MESSAGE_LOG_TTL_DAYS,
    workspaceEventTtlDays:
      opts.defaults?.workspaceEventTtlDays !== undefined
        ? opts.defaults.workspaceEventTtlDays
        : DEFAULT_WORKSPACE_EVENT_TTL_DAYS,
  };

  // Workspaces with explicit settings get their own pass; everyone else is
  // covered by one unscoped pass per table using the deployment default.
  const overrides = await db
    .select({ id: workspaces.id, retention: workspaces.retention })
    .from(workspaces)
    .where(isNotNull(workspaces.retention));
  const overrideIds = overrides.map((o) => o.id);

  function passes(
    defaultTtlDays: number | null,
    pick: (settings: WorkspaceRetentionSettings) => number | null | undefined,
    workspaceIdColumn: SQLiteColumn,
  ): PrunePass[] {
    const out: PrunePass[] = [];
    if (defaultTtlDays != null && defaultTtlDays > 0) {
      out.push({
        cutoff: new Date(now.getTime() - defaultTtlDays * DAY_MS),
        scope: overrideIds.length > 0 ? notInArray(workspaceIdColumn, overrideIds) : undefined,
      });
    }
    for (const override of overrides) {
      const setting = pick(override.retention ?? {});
      // undefined inherits the default; explicit null disables pruning.
      const ttlDays = setting === undefined ? defaultTtlDays : setting;
      if (ttlDays != null && ttlDays > 0) {
        out.push({
          cutoff: new Date(now.getTime() - ttlDays * DAY_MS),
          scope: eq(workspaceIdColumn, override.id),
        });
      }
    }
    return out;
  }

  async function drain(deleteBatch: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const deleted = await deleteBatch();
      total += deleted;
      if (deleted < batchLimit) break;
    }
    return total;
  }

  const result: PruneResult = { messages: 0, deliveries: 0, messageLogs: 0, readReceipts: 0, workspaceEvents: 0 };

  // Messages — leaf-first so the self-referencing thread FK never breaks.
  for (const pass of passes(defaults.messageTtlDays, (s) => s.message_ttl_days, messages.workspaceId)) {
    result.messages += await drain(async () => {
      const batch = db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            olderThanSnowflake(messages.id, pass.cutoff.getTime()),
            sql`NOT EXISTS (SELECT 1 FROM messages replies WHERE replies.thread_id = ${messages.id})`,
            pass.scope,
          ),
        )
        .limit(batchLimit);
      const deleted = await db
        .delete(messages)
        .where(inArray(messages.id, batch))
        .returning({ id: messages.id });
      return deleted.length;
    });
  }

  // Settled deliveries.
  for (const pass of passes(defaults.deliveryTtlDays, (s) => s.delivery_ttl_days, deliveries.workspaceId)) {
    result.deliveries += await drain(async () => {
      const batch = db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(
          and(
            inArray(deliveries.status, SETTLED_DELIVERY_STATUSES),
            lt(deliveries.createdAt, pass.cutoff),
            pass.scope,
          ),
        )
        .limit(batchLimit);
      const deleted = await db
        .delete(deliveries)
        .where(inArray(deliveries.id, batch))
        .returning({ id: deliveries.id });
      return deleted.length;
    });
  }

  // Message logs.
  for (const pass of passes(defaults.messageLogTtlDays, (s) => s.message_log_ttl_days, messageLogs.workspaceId)) {
    result.messageLogs += await drain(async () => {
      const batch = db
        .select({ id: messageLogs.id })
        .from(messageLogs)
        .where(and(olderThanSnowflake(messageLogs.id, pass.cutoff.getTime()), pass.scope))
        .limit(batchLimit);
      const deleted = await db
        .delete(messageLogs)
        .where(inArray(messageLogs.id, batch))
        .returning({ id: messageLogs.id });
      return deleted.length;
    });
  }

  // Workspace event log (durable observer plane; composite PK, batched via rowid).
  // Each workspace's highest-seq row is always retained as the seq high-water
  // mark: seq is assigned as MAX(seq)+1, so pruning a workspace to zero rows
  // would reset the sequence and strand every persisted observer cursor (and
  // confuse live-frame dedupe). One stale row per workspace is the cheap price.
  for (const pass of passes(defaults.workspaceEventTtlDays, (s) => s.workspace_event_ttl_days, workspaceEvents.workspaceId)) {
    result.workspaceEvents += await drain(async () => {
      const batch = db
        .select({ rowid: sql<number>`rowid` })
        .from(workspaceEvents)
        .where(and(
          lt(workspaceEvents.createdAt, pass.cutoff),
          pass.scope,
          sql`${workspaceEvents.seq} < (
            SELECT MAX(hw.seq) FROM workspace_events hw
            WHERE hw.workspace_id = ${workspaceEvents.workspaceId}
          )`,
        ))
        .limit(batchLimit);
      const deleted = await db
        .delete(workspaceEvents)
        .where(inArray(sql`rowid`, batch))
        .returning({ seq: workspaceEvents.seq });
      return deleted.length;
    });
  }

  // Orphaned read receipts (referential garbage, always swept).
  result.readReceipts += await drain(async () => {
    const orphaned = db
      .select({ messageId: readReceipts.messageId })
      .from(readReceipts)
      .leftJoin(messages, eq(messages.id, readReceipts.messageId))
      .where(isNull(messages.id))
      .limit(batchLimit);
    const deleted = await db
      .delete(readReceipts)
      .where(inArray(readReceipts.messageId, orphaned))
      .returning({ messageId: readReceipts.messageId });
    return deleted.length;
  });

  return result;
}
