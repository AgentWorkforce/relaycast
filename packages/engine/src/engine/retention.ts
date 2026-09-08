import { eq, sql, type SQL } from 'drizzle-orm';
import { pruneBounded } from './boundedRetention.js';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { EffectiveMessageRetention } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { workspaces } from '../db/schema.js';
import { snowflakeIdLowerBound } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

const DAY_MS = 86_400_000;
export const DEFAULT_DELIVERY_TTL_DAYS = 90;
export const DEFAULT_MESSAGE_LOG_TTL_DAYS = 90;
export const DEFAULT_WORKSPACE_EVENT_TTL_DAYS = 30;

/**
 * Deployment-wide TTL fallbacks, applied to workspaces without their own
 * `workspaces.retention` settings. `null` disables pruning for that table.
 */
export interface RetentionDefaults {
  /** Messages are user data: no default — pruning is opt-in per workspace or via this deployment default. */
  messageTtlDays?: number | null;
  /** Default {@link DEFAULT_DELIVERY_TTL_DAYS}. */
  deliveryTtlDays?: number | null;
  /** Default {@link DEFAULT_MESSAGE_LOG_TTL_DAYS}. */
  messageLogTtlDays?: number | null;
  /** Default {@link DEFAULT_WORKSPACE_EVENT_TTL_DAYS}. */
  workspaceEventTtlDays?: number | null;
}

export interface PruneOptions {
  /** Stop starting candidate pages after this elapsed budget (default 10s, capped at 30s). */
  maxDurationMs?: number;
  /** Max candidate rows examined per table per batch. Default/cap 200. */
  batchLimit?: number;
  /** Max candidate batches per table per call. Default/cap 5; durable cursors resume on the next call. */
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
 * Resolve the live message-retention boundary for one workspace.
 *
 * An omitted deployment default is deliberately `unknown`, not never-prune:
 * hosted adapters may prune outside the engine process, and claiming unlimited
 * coverage from absent configuration is the replay workstream's named failure
 * mode. The Node adapter always supplies its actual default explicitly.
 */
export async function resolveEffectiveMessageRetention(
  db: Db,
  workspaceId: string,
  deploymentMessageTtlDays: number | null | undefined,
  now: Date = new Date(),
): Promise<EffectiveMessageRetention> {
  const [workspace] = await db
    .select({ retention: workspaces.retention })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    return {
      policy: 'unknown',
      message_ttl_days: null,
      retained_since: null,
      source: 'unknown',
      reason: 'workspace_unknown',
    };
  }

  const workspaceTtl = workspace.retention?.message_ttl_days;
  const source = workspaceTtl === undefined
    ? 'deployment_default' as const
    : 'workspace_override' as const;
  const ttlDays = workspaceTtl === undefined ? deploymentMessageTtlDays : workspaceTtl;

  if (ttlDays === undefined) {
    return {
      policy: 'unknown',
      message_ttl_days: null,
      retained_since: null,
      source: 'unknown',
      reason: 'boundary_unavailable',
    };
  }

  if (
    ttlDays !== null
    && (!Number.isFinite(ttlDays) || (ttlDays > 0 && !Number.isFinite(now.getTime())))
  ) {
    return {
      policy: 'unknown',
      message_ttl_days: null,
      retained_since: null,
      source: 'unknown',
      reason: 'boundary_unavailable',
    };
  }

  if (ttlDays === null || ttlDays <= 0) {
    return {
      policy: 'never_prune',
      message_ttl_days: null,
      retained_since: null,
      source,
    };
  }

  return {
    policy: 'window',
    message_ttl_days: ttlDays,
    retained_since: new Date(now.getTime() - ttlDays * DAY_MS).toISOString(),
    source,
  };
}

/** Numeric `column >= snowflakeIdLowerBound(cutoff)` for decimal TEXT ids. */
export function atOrAfterSnowflake(column: SQLiteColumn, cutoffMs: number): SQL {
  const bound = snowflakeIdLowerBound(cutoffMs);
  return sql`(length(${column}), ${column}) >= (${bound.length}, ${bound})`;
}

/** Numeric `column > cursor` for decimal TEXT snowflake ids. */
export function afterSnowflake(column: SQLiteColumn, cursor: string): SQL {
  return sql`(length(${column}), ${column}) > (${cursor.length}, ${cursor})`;
}

/** Bounded, resumable retention; preserves TTL overrides and event high-water marks. */
export async function pruneExpired(db: Db, opts: PruneOptions = {}): Promise<PruneResult> {
  return pruneBounded(db, opts);
}
