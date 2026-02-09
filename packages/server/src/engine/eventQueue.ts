import { eq, and, sql, lte } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { pendingEvents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { deliverEvent } from './eventDelivery.js';
import { publishEvent, type WsEvent } from '../ws/pubsub.js';

export async function enqueueEvent(
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  wsEvent?: WsEvent,
): Promise<string> {
  const db = getDb();
  const id = generateId();

  await db.insert(pendingEvents).values({
    id,
    workspaceId,
    eventType,
    payload: { ...payload, _wsEvent: wsEvent || null },
  });

  return id;
}

export async function processEventQueue(batchSize = 20): Promise<number> {
  const db = getDb();
  const now = new Date();

  // Claim a batch of pending events using atomic update
  const batch = await db
    .select()
    .from(pendingEvents)
    .where(
      and(
        eq(pendingEvents.status, 'pending'),
        lte(pendingEvents.processAfter, now),
      ),
    )
    .orderBy(pendingEvents.createdAt)
    .limit(batchSize);

  if (batch.length === 0) return 0;

  let processed = 0;
  for (const event of batch) {
    // Mark as processing
    await db
      .update(pendingEvents)
      .set({ status: 'processing', attempts: sql`${pendingEvents.attempts} + 1` })
      .where(eq(pendingEvents.id, event.id));

    try {
      const payload = event.payload as Record<string, unknown>;
      const wsEvent = payload._wsEvent as WsEvent | null;

      // Publish to WebSocket subscribers
      if (wsEvent) {
        await publishEvent(wsEvent);
      }

      // Deliver webhooks
      const { _wsEvent, ...cleanPayload } = payload;
      await deliverEvent(event.workspaceId, event.eventType, cleanPayload);

      // Mark completed
      await db
        .update(pendingEvents)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(pendingEvents.id, event.id));

      processed++;
    } catch (err) {
      const attempts = (event.attempts ?? 0) + 1;
      const maxAttempts = event.maxAttempts ?? 5;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (attempts >= maxAttempts) {
        await db
          .update(pendingEvents)
          .set({ status: 'failed', lastError: errorMsg })
          .where(eq(pendingEvents.id, event.id));
      } else {
        // Exponential backoff: 2^attempts seconds
        const backoffMs = Math.pow(2, attempts) * 1000;
        const processAfter = new Date(Date.now() + backoffMs);
        await db
          .update(pendingEvents)
          .set({ status: 'pending', lastError: errorMsg, processAfter })
          .where(eq(pendingEvents.id, event.id));
      }
    }
  }

  return processed;
}

// Cleanup completed events older than given age (default 24h)
export async function cleanupCompletedEvents(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeMs);

  const deleted = await db
    .delete(pendingEvents)
    .where(
      and(
        eq(pendingEvents.status, 'completed'),
        lte(pendingEvents.completedAt, cutoff),
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
