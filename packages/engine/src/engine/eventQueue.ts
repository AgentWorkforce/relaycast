import { and, lte, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { pendingEvents } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

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
