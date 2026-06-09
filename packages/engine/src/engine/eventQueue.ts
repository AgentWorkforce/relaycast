import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { pendingEvents } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

/** A `pending_events` row claimed for delivery (attempts already incremented). */
export interface ClaimedEvent {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export async function enqueueEvent(
  db: Db,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = generateId();

  await db.insert(pendingEvents).values({
    id,
    workspaceId,
    eventType,
    payload,
  });

  return id;
}

/**
 * Atomically claim up to `limit` due events: `pending`, `process_after <= now`,
 * `attempts < max_attempts`. Claiming increments `attempts` and pushes
 * `process_after` out by `leaseMs`, so a worker that crashes mid-delivery
 * leaves the row reclaimable once the lease expires (one attempt consumed).
 *
 * Single `UPDATE ... WHERE id IN (subquery) RETURNING` statement — atomic on
 * both drivers per the no-interactive-transactions doctrine (ports/database.ts).
 */
export async function claimDueEvents(
  db: Db,
  opts: { limit?: number; leaseMs?: number; now?: Date } = {},
): Promise<ClaimedEvent[]> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 25;
  const leaseMs = opts.leaseMs ?? 60_000;

  const due = db
    .select({ id: pendingEvents.id })
    .from(pendingEvents)
    .where(
      and(
        eq(pendingEvents.status, 'pending'),
        lte(pendingEvents.processAfter, now),
        lt(pendingEvents.attempts, pendingEvents.maxAttempts),
      ),
    )
    .orderBy(asc(pendingEvents.processAfter))
    .limit(limit);

  const claimed = await db
    .update(pendingEvents)
    .set({
      attempts: sql`${pendingEvents.attempts} + 1`,
      processAfter: new Date(now.getTime() + leaseMs),
    })
    .where(inArray(pendingEvents.id, due))
    .returning();

  return claimed.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    eventType: row.eventType,
    payload: row.payload as Record<string, unknown>,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  }));
}

/** Delivery succeeded — drop the row. */
export async function completeEvent(db: Db, id: string): Promise<void> {
  await db.delete(pendingEvents).where(eq(pendingEvents.id, id));
}

/**
 * Terminal failure (non-retryable response or attempts exhausted) — settle the
 * row as `failed` so it stops being claimed; `cleanupOldEvents` prunes it later.
 * The status guard keeps this idempotent and preserves the first failure.
 */
export async function failEvent(db: Db, id: string, error: string): Promise<void> {
  await db
    .update(pendingEvents)
    .set({ status: 'failed', lastError: error, completedAt: new Date() })
    .where(and(eq(pendingEvents.id, id), eq(pendingEvents.status, 'pending')));
}

/** Retryable failure — keep the row `pending` and make it due again after `backoffMs`. */
export async function rescheduleEvent(
  db: Db,
  id: string,
  error: string,
  backoffMs: number,
): Promise<void> {
  await db
    .update(pendingEvents)
    .set({ processAfter: new Date(Date.now() + backoffMs), lastError: error })
    .where(and(eq(pendingEvents.id, id), eq(pendingEvents.status, 'pending')));
}

// Cleanup completed and failed events older than given age (default 24h)
export async function cleanupOldEvents(db: Db, maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);

  const deleted = await db
    .delete(pendingEvents)
    .where(
      and(
        inArray(pendingEvents.status, ['completed', 'failed']),
        lte(pendingEvents.createdAt, cutoff),
      ),
    )
    .returning();

  return deleted.length;
}
