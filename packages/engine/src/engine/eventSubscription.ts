import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { eventSubscriptions } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

function redactHeaders(headers: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!headers) return null;
  return Object.fromEntries(Object.keys(headers).map((name) => [name, '[redacted]']));
}

export async function createSubscription(
  db: Db,
  workspaceId: string,
  data: {
    events: string[];
    filter?: { channel?: string; mentions?: string } | null;
    url: string;
    headers?: Record<string, string>;
    secret?: string;
  },
) {
  const id = `sub_${generateId()}`;

  const [sub] = await db
    .insert(eventSubscriptions)
    .values({
      id,
      workspaceId,
      events: data.events,
      filter: data.filter || null,
      url: data.url,
      headers: data.headers ?? null,
      secret: data.secret || null,
    })
    .returning();

  return {
    id: sub.id,
    events: sub.events as string[],
    filter: sub.filter as { channel?: string; mentions?: string } | null,
    url: sub.url,
    headers: redactHeaders(sub.headers as Record<string, string> | null),
    is_active: sub.isActive,
    created_at: sub.createdAt.toISOString(),
  };
}

export async function listSubscriptions(db: Db, workspaceId: string) {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.workspaceId, workspaceId));

  return rows.map((r) => ({
    id: r.id,
    events: r.events as string[],
    filter: r.filter as { channel?: string; mentions?: string } | null,
    url: r.url,
    headers: redactHeaders(r.headers as Record<string, string> | null),
    is_active: r.isActive,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getSubscription(db: Db, workspaceId: string, subId: string) {
  const [row] = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.id, subId),
        eq(eventSubscriptions.workspaceId, workspaceId),
      ),
    );

  if (!row) return null;

  return {
    id: row.id,
    events: row.events as string[],
    filter: row.filter as { channel?: string; mentions?: string } | null,
    url: row.url,
    headers: redactHeaders(row.headers as Record<string, string> | null),
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

export async function deleteSubscription(db: Db, workspaceId: string, subId: string) {
  const result = await db
    .delete(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.id, subId),
        eq(eventSubscriptions.workspaceId, workspaceId),
      ),
    )
    .returning();

  return result.length > 0;
}

/**
 * Whether the workspace has any active event subscription at all — a cheap
 * existence probe (indexed lookup, LIMIT 1) used to skip outbox writes for
 * workspaces that have no webhooks configured.
 */
export async function hasActiveSubscriptions(db: Db, workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: eventSubscriptions.id })
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.workspaceId, workspaceId),
        eq(eventSubscriptions.isActive, true),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export async function getActiveSubscriptions(
  db: Db,
  workspaceId: string,
  eventType: string,
) {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.workspaceId, workspaceId),
        eq(eventSubscriptions.isActive, true),
      ),
    );

  // Filter to subscriptions that include this event type
  return rows.filter((r) => {
    const events = r.events as string[];
    return events.includes(eventType) || events.includes('*');
  });
}
