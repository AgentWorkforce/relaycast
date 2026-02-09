import { eq, and, sql, lte, inArray } from 'drizzle-orm';
import { getDb, getSql } from '../db/index.js';
import { pendingEvents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { deliverEvent } from './eventDelivery.js';

export async function enqueueEvent(
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const db = getDb();
  const id = generateId();

  await db.insert(pendingEvents).values({
    id,
    workspaceId,
    eventType,
    payload,
  });

  return id;
}

export async function processEventQueue(batchSize = 20): Promise<number> {
  const rawSql = getSql();
  const db = getDb();
  const now = new Date();

  // Atomically claim a batch: UPDATE ... WHERE status='pending' RETURNING
  // This prevents duplicate processing across multiple workers
  const claimed = await rawSql`
    UPDATE pending_events
    SET status = 'processing',
        attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM pending_events
      WHERE status = 'pending' AND process_after <= ${now}
      ORDER BY created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;

  if (claimed.length === 0) return 0;

  let processed = 0;
  for (const event of claimed) {
    const currentAttempts = event.attempts as number;

    try {
      // Deliver webhooks only — real-time pub/sub is handled
      // directly in the route handler for low latency
      await deliverEvent(event.workspace_id as string, event.event_type as string, event.payload as Record<string, unknown>);

      // Mark completed
      await db
        .update(pendingEvents)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(pendingEvents.id, event.id as string));

      processed++;
    } catch (err) {
      const maxAttempts = (event.max_attempts as number) ?? 5;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (currentAttempts >= maxAttempts) {
        await db
          .update(pendingEvents)
          .set({ status: 'failed', lastError: errorMsg })
          .where(eq(pendingEvents.id, event.id as string));
      } else {
        // Exponential backoff: 2^attempts seconds
        const backoffMs = Math.pow(2, currentAttempts) * 1000;
        const processAfter = new Date(Date.now() + backoffMs);
        await db
          .update(pendingEvents)
          .set({ status: 'pending', lastError: errorMsg, processAfter })
          .where(eq(pendingEvents.id, event.id as string));
      }
    }
  }

  return processed;
}

// Cleanup completed and failed events older than given age (default 24h)
export async function cleanupOldEvents(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const db = getDb();
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

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export function startEventQueuePoller(intervalMs = 2000): void {
  if (pollingTimer) return;
  pollingTimer = setInterval(async () => {
    try {
      await processEventQueue();
    } catch {
      // Polling errors are non-critical; will retry next interval
    }
  }, intervalMs);
}

export function stopEventQueuePoller(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
