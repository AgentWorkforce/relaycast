import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { eventSubscriptions } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

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
    headers: (sub.headers as Record<string, string> | null) ?? null,
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
    headers: (r.headers as Record<string, string> | null) ?? null,
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
    headers: (row.headers as Record<string, string> | null) ?? null,
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
