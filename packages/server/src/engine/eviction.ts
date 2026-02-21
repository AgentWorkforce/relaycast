import { sql, eq, lte, isNull, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ── Phase 1: Suspend ────────────────────────────────────────────────

/**
 * Suspend workspaces that have had no activity for 30+ days.
 * Sets `suspendedAt` without deleting any data.
 * Returns the list of suspended workspace IDs.
 */
export async function suspendInactiveWorkspaces(
  db: Db,
  maxInactiveMs: number = THIRTY_DAYS_MS,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxInactiveMs);

  const rows = await db
    .update(workspaces)
    .set({ suspendedAt: sql`(unixepoch())` })
    .where(
      and(
        lte(workspaces.lastActivityAt, cutoff),
        isNull(workspaces.suspendedAt),
      ),
    )
    .returning({ id: workspaces.id });

  return rows.map((r) => r.id);
}

// ── Phase 2: Hard delete ────────────────────────────────────────────

/**
 * Hard-delete workspaces that have been suspended for 30+ days
 * (i.e. 60+ days total inactivity). Cleans up R2 files first.
 * Returns the list of evicted workspace IDs.
 */
export async function evictSuspendedWorkspaces(
  db: Db,
  env: { FILES_BUCKET: R2Bucket },
  maxSuspendedMs: number = THIRTY_DAYS_MS,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxSuspendedMs);

  const candidates = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(lte(workspaces.suspendedAt, cutoff))
    .limit(50);

  const evicted: string[] = [];
  for (const { id } of candidates) {
    await purgeWorkspaceR2(env.FILES_BUCKET, id);
    await db.delete(workspaces).where(eq(workspaces.id, id));
    evicted.push(id);
  }

  return evicted;
}

// ── R2 cleanup ──────────────────────────────────────────────────────

/**
 * Delete all R2 objects under `{workspaceId}/`.
 * R2 `delete()` accepts up to 1000 keys per call.
 */
async function purgeWorkspaceR2(
  bucket: R2Bucket,
  workspaceId: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${workspaceId}/`, cursor });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

// ── Activity touch ──────────────────────────────────────────────────

/**
 * Touch `lastActivityAt` for a workspace and clear `suspendedAt`
 * if it was set (reviving a suspended workspace).
 */
export async function touchWorkspaceActivity(
  db: Db,
  workspaceId: string,
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      lastActivityAt: sql`(unixepoch())`,
      suspendedAt: null,
    })
    .where(eq(workspaces.id, workspaceId));
}
