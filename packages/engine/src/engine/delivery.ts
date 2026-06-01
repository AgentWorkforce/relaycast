import { eq, ne, and, not, asc, isNull, inArray, notInArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { deliveries, messages, agents } from '../db/schema.js';
import type { DeliveryStatus } from '@relaycast/types';

type Db = ReturnType<typeof getDb>;

type DeliveryRow = typeof deliveries.$inferSelect;

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function serializeDelivery(row: DeliveryRow & { channelId?: string }) {
  return {
    id: row.id,
    message_id: row.messageId,
    channel_id: row.channelId ?? '',
    agent_id: row.agentId,
    status: row.status as DeliveryStatus,
    mode: row.mode,
    reason: row.reason,
    priority: row.priority,
    retryable: row.retryable ?? null,
    error: row.error,
    available_at: toIso(row.availableAt),
    deadline: toIso(row.deadline),
    created_at: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updated_at: toIso(row.updatedAt),
  };
}

/**
 * List durable delivery items for an agent. Defaults to the non-terminal
 * (`accepted` + `deferred`) queue so an offline consumer can replay what it
 * missed on reconnect, oldest first (FIFO). Each item carries the message
 * payload so the consumer does not need a second round-trip.
 */
export async function listDeliveries(
  db: Db,
  workspaceId: string,
  agentId: string,
  opts: { status?: DeliveryStatus; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const statusFilter = opts.status
    ? eq(deliveries.status, opts.status)
    : inArray(deliveries.status, ['accepted', 'deferred']);

  const rows = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.workspaceId, workspaceId),
        eq(deliveries.agentId, agentId),
        statusFilter,
      ),
    )
    .orderBy(asc(deliveries.createdAt), asc(deliveries.id))
    .limit(limit);

  if (rows.length === 0) return [];

  const messageIds = [...new Set(rows.map((r) => r.messageId))];
  const msgRows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      agentId: messages.agentId,
      agentName: agents.name,
      body: messages.body,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(agents, eq(messages.agentId, agents.id))
    .where(inArray(messages.id, messageIds));
  const msgById = new Map(msgRows.map((m) => [m.id, m]));

  return rows.map((row) => {
    const msg = msgById.get(row.messageId);
    return {
      ...serializeDelivery(row),
      channel_id: msg?.channelId ?? '',
      message: msg
        ? {
          id: msg.id,
          channel_id: msg.channelId,
          agent_id: msg.agentId ?? null,
          agent_name: msg.agentName ?? null,
          text: msg.body,
          thread_id: msg.threadId ?? null,
          created_at: msg.createdAt.toISOString(),
        }
        : null,
    };
  });
}

/**
 * Fetch a single delivery owned by the agent, joined to its message so the
 * caller has the `channelId` for serialization. Returns null if not found.
 */
async function getOwnedDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
): Promise<(DeliveryRow & { channelId: string }) | null> {
  const [row] = await db
    .select({ delivery: deliveries, channelId: messages.channelId })
    .from(deliveries)
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .where(
      and(
        eq(deliveries.id, deliveryId),
        eq(deliveries.workspaceId, workspaceId),
        eq(deliveries.agentId, agentId),
      ),
    );
  return row ? { ...row.delivery, channelId: row.channelId } : null;
}

// The outcome of a transition: the (possibly unchanged) delivery plus whether
// this call actually mutated state. Callers fan out lifecycle events only when
// `changed` is true so idempotent retries don't emit duplicate notifications.
export type TransitionResult = { delivery: ReturnType<typeof serializeDelivery>; changed: boolean };

/**
 * Idempotently transition a delivery to `delivered`. `delivered` is terminal,
 * so repeated acks are no-ops (reported as `changed: false`). Returns null if
 * the delivery is not found / not owned.
 */
export async function ackDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
): Promise<TransitionResult | null> {
  const existing = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  if (!existing) return null;
  if (existing.status === 'delivered') return { delivery: serializeDelivery(existing), changed: false };

  // The `status != 'delivered'` predicate lives in the UPDATE so the DB decides
  // atomically whether this call transitioned the row. Under concurrent acks
  // only one update matches (SQLite serializes writes); the loser sees no row
  // and reports `changed: false`, so the delivered event fires exactly once.
  const [updated] = await db
    .update(deliveries)
    .set({ status: 'delivered', updatedAt: new Date() })
    .where(and(eq(deliveries.id, deliveryId), ne(deliveries.status, 'delivered')))
    .returning();
  return resolveTransition(db, workspaceId, agentId, deliveryId, updated, existing.channelId);
}

/**
 * Idempotently record a delivery as `failed`, capturing error text and
 * retryability. Both `delivered` and `failed` are treated as settled: once a
 * delivery has failed, repeated calls are no-ops that preserve the original
 * failure metadata (no `null` overwrite, no `updatedAt` churn, no duplicate
 * event). The WHERE guard also closes the read→write race against a concurrent
 * ack. Returns null if not found / not owned.
 */
export async function failDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
  opts: { error?: string; retryable?: boolean } = {},
): Promise<TransitionResult | null> {
  const existing = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  if (!existing) return null;
  if (existing.status === 'delivered' || existing.status === 'failed') {
    return { delivery: serializeDelivery(existing), changed: false };
  }

  // Both `delivered` and `failed` are settled, so the UPDATE only matches a
  // not-yet-settled row. Under concurrent fails the DB lets exactly one win;
  // the loser matches no row, preserves the first failure's metadata, and
  // reports `changed: false` (no duplicate event).
  const [updated] = await db
    .update(deliveries)
    .set({
      status: 'failed',
      error: opts.error ?? null,
      retryable: opts.retryable ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(deliveries.id, deliveryId), notInArray(deliveries.status, ['delivered', 'failed'])))
    .returning();
  return resolveTransition(db, workspaceId, agentId, deliveryId, updated, existing.channelId);
}

/**
 * Idempotently record a delivery as `deferred` with the time it next becomes
 * available. A re-defer to the same `available_at`/reason is a no-op (reported
 * as `changed: false`); deferring to a new time is a real change. `delivered`
 * is terminal, so a defer never resurrects an already-acked delivery (the WHERE
 * guard also closes the read→write race against a concurrent ack). Returns null
 * if not found / not owned.
 */
export async function deferDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
  opts: { availableAt: Date; reason?: string },
): Promise<TransitionResult | null> {
  const existing = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  if (!existing) return null;
  if (existing.status === 'delivered') return { delivery: serializeDelivery(existing), changed: false };

  const targetReason = opts.reason ?? existing.reason;
  const reasonMatches = targetReason === null
    ? isNull(deliveries.reason)
    : eq(deliveries.reason, targetReason);
  // A real change means: not terminal-delivered, and not already deferred to
  // this exact (available_at, reason). Encoding the no-op predicate in the
  // UPDATE makes it atomic — identical concurrent defers match no row on the
  // loser and report `changed: false`, so no duplicate event fires.
  const isNoop = and(
    eq(deliveries.status, 'deferred'),
    eq(deliveries.availableAt, opts.availableAt),
    reasonMatches,
  )!;
  const [updated] = await db
    .update(deliveries)
    .set({
      status: 'deferred',
      availableAt: opts.availableAt,
      reason: targetReason,
      updatedAt: new Date(),
    })
    .where(and(
      eq(deliveries.id, deliveryId),
      ne(deliveries.status, 'delivered'),
      not(isNoop),
    ))
    .returning();
  return resolveTransition(db, workspaceId, agentId, deliveryId, updated, existing.channelId);
}

/**
 * Resolve the result of a status-guarded transition: when the write landed,
 * report the updated row as changed. When it did not (the row was deleted, or a
 * concurrent ack won the race and the row is now terminal), re-read and return
 * the current state as unchanged — never resurrecting it or emitting an event.
 */
async function resolveTransition(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
  updated: DeliveryRow | undefined,
  channelId: string,
): Promise<TransitionResult | null> {
  if (updated) return { delivery: serializeDelivery({ ...updated, channelId }), changed: true };
  const current = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  return current ? { delivery: serializeDelivery(current), changed: false } : null;
}
