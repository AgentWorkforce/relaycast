import { eq, and, lt, or, isNull, isNotNull, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { organizations, workspaces, messages, sessions, emailVerifications } from '../db/schema.js';
import type { Logger } from '../lib/logger.js';

type Db = ReturnType<typeof getDb>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Daily cron job:
 * 1. Trim messages older than 30 days for free-plan orgs
 * 2. Soft-delete workspaces inactive for 60 days (free orgs)
 * 3. Hard-delete workspaces 30 days after soft-delete
 * 4. Clean up expired sessions and email verifications
 */
export async function runTtlCleanup(db: Db, logger: Logger) {
  const now = Date.now();

  // 1. Trim old messages for free orgs
  const freeOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.plan, 'free'));

  let trimmedMessages = 0;
  const thirtyDaysAgo = new Date(now - THIRTY_DAYS_MS);

  for (const org of freeOrgs) {
    // Get workspace IDs for this org
    const orgWorkspaces = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, org.id),
          isNull(workspaces.deletedAt),
        ),
      );

    for (const ws of orgWorkspaces) {
      const result = await db
        .delete(messages)
        .where(
          and(
            eq(messages.workspaceId, ws.id),
            lt(messages.createdAt, thirtyDaysAgo),
          ),
        );
      trimmedMessages += (result as any).changes ?? 0;
    }
  }

  if (trimmedMessages > 0) {
    logger.info('Trimmed old messages for free orgs', { trimmed: trimmedMessages });
  }

  // 2. Soft-delete workspaces inactive for 60+ days (free orgs only)
  const sixtyDaysAgo = new Date(now - SIXTY_DAYS_MS);
  let softDeleted = 0;

  for (const org of freeOrgs) {
    const staleWorkspaces = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, org.id),
          isNull(workspaces.deletedAt),
          or(
            lt(workspaces.lastActivityAt, sixtyDaysAgo),
            and(isNull(workspaces.lastActivityAt), lt(workspaces.createdAt, sixtyDaysAgo)),
          ),
        ),
      );

    for (const ws of staleWorkspaces) {
      await db
        .update(workspaces)
        .set({ deletedAt: new Date() })
        .where(eq(workspaces.id, ws.id));
      softDeleted++;
    }
  }

  if (softDeleted > 0) {
    logger.info('Soft-deleted stale workspaces', { count: softDeleted });
  }

  // 3. Hard-delete workspaces 30 days after soft-delete
  const softDeleteCutoff = new Date(now - THIRTY_DAYS_MS);
  const toHardDelete = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        isNotNull(workspaces.deletedAt),
        lt(workspaces.deletedAt, softDeleteCutoff),
      ),
    );

  for (const ws of toHardDelete) {
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  }

  if (toHardDelete.length > 0) {
    logger.info('Hard-deleted expired workspaces', { count: toHardDelete.length });
  }

  // 4. Clean up expired sessions and verification codes
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.delete(emailVerifications).where(lt(emailVerifications.expiresAt, new Date()));
}
