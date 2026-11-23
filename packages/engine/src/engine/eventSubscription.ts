import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { eventSubscriptions } from '../db/tables.js';
import * as sqlx from '../db/sqlx.js';
import { codedError } from '../lib/httpError.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export type SubscriptionFilter = { channel?: string; mentions?: string; recipients?: string[] };

/** Whether a subscription's `events` list covers `eventType`, including the `'*'` wildcard. */
export function subscribesToEventType(events: readonly string[], eventType: string): boolean {
  return events.includes(eventType) || events.includes('*');
}

function redactHeaders(headers: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!headers) return null;
  return Object.fromEntries(Object.keys(headers).map((name) => [name, '[redacted]']));
}

export async function createSubscription(
  db: Db,
  workspaceId: string,
  data: {
    events: string[];
    filter?: SubscriptionFilter | null;
    url: string;
    headers?: Record<string, string>;
    secret?: string;
    signatureScheme?: 'legacy' | 'standard-webhooks';
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
      signatureScheme: data.signatureScheme ?? 'legacy',
    })
    .returning();

  return toPublicSubscription(sub);
}

export async function listSubscriptions(db: Db, workspaceId: string) {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.workspaceId, workspaceId));

  return rows.map(toPublicSubscription);
}

function toPublicSubscription(r: typeof eventSubscriptions.$inferSelect) {
  return {
    id: r.id,
    events: r.events as string[],
    filter: r.filter as SubscriptionFilter | null,
    url: r.url,
    headers: redactHeaders(r.headers as Record<string, string> | null),
    signature_scheme: r.signatureScheme,
    is_active: r.isActive,
    created_at: r.createdAt.toISOString(),
  };
}

/** The stored row, secret included, for validating an update against its result. */
export async function getSubscriptionRow(db: Db, workspaceId: string, subId: string) {
  const [row] = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.id, subId),
        eq(eventSubscriptions.workspaceId, workspaceId),
      ),
    );
  return row ?? null;
}

export async function getSubscription(db: Db, workspaceId: string, subId: string) {
  const row = await getSubscriptionRow(db, workspaceId, subId);
  return row ? toPublicSubscription(row) : null;
}

/**
 * Applies `data` only if the signing pair still matches `expected`, the values
 * the caller validated the result against. A concurrent change to the scheme or
 * secret makes this a 409 instead of storing an unvalidated pair; a row that is
 * gone returns null.
 */
export async function updateSubscription(
  db: Db,
  workspaceId: string,
  subId: string,
  data: {
    events?: string[];
    filter?: SubscriptionFilter | null;
    url?: string;
    headers?: Record<string, string>;
    secret?: string | null;
    signatureScheme?: 'legacy' | 'standard-webhooks';
    isActive?: boolean;
  },
  expected: { signatureScheme: 'legacy' | 'standard-webhooks'; secret: string | null },
) {
  const [row] = await db
    .update(eventSubscriptions)
    .set({
      ...(data.events !== undefined ? { events: data.events } : {}),
      ...(data.filter !== undefined ? { filter: data.filter } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.headers !== undefined ? { headers: data.headers } : {}),
      ...(data.secret !== undefined ? { secret: data.secret || null } : {}),
      ...(data.signatureScheme !== undefined ? { signatureScheme: data.signatureScheme } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    })
    .where(
      and(
        eq(eventSubscriptions.id, subId),
        eq(eventSubscriptions.workspaceId, workspaceId),
        eq(eventSubscriptions.signatureScheme, expected.signatureScheme),
        sqlx.isNotDistinct(db, eventSubscriptions.secret, sqlx.textParam(db, expected.secret)),
      ),
    )
    .returning();

  if (row) return toPublicSubscription(row);
  if (await getSubscriptionRow(db, workspaceId, subId)) {
    throw codedError('Subscription changed concurrently; retry the update', 'subscription_update_conflict', 409);
  }
  return null;
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

/** Read bound for {@link listActiveSubscriptionMatchers}. */
export const MAX_SUBSCRIPTION_MATCHERS = 100;

export type SubscriptionMatcher = { events: string[]; filter: SubscriptionFilter | null };

/**
 * The `events` and `filter` of every active subscription in the workspace, so
 * the send path can skip outbox writes no subscription would deliver. Returns
 * `null` (caller fails open and enqueues) above {@link MAX_SUBSCRIPTION_MATCHERS}
 * rows, which keeps this read bounded.
 */
export async function listActiveSubscriptionMatchers(
  db: Db,
  workspaceId: string,
): Promise<SubscriptionMatcher[] | null> {
  const rows = await db
    .select({ events: eventSubscriptions.events, filter: eventSubscriptions.filter })
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.workspaceId, workspaceId),
        eq(eventSubscriptions.isActive, true),
      ),
    )
    .limit(MAX_SUBSCRIPTION_MATCHERS + 1);

  if (rows.length > MAX_SUBSCRIPTION_MATCHERS) return null;
  return rows.map((r) => ({ events: r.events as string[], filter: r.filter as SubscriptionFilter | null }));
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

  return rows.filter((r) => subscribesToEventType(r.events as string[], eventType));
}
