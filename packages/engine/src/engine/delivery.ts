import { eq, and, asc, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { deliveries, messages, agents } from '../db/schema.js';
import type { DeliveryStatus } from '@relaycast/types';

type Db = ReturnType<typeof getDb>;

type DeliveryRow = typeof deliveries.$inferSelect;

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function serializeDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    message_id: row.messageId,
    channel_id: '', // filled in by callers that have the message row
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

/** Fetch a single delivery owned by the agent, or null. */
async function getOwnedDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
): Promise<DeliveryRow | null> {
  const [row] = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.id, deliveryId),
        eq(deliveries.workspaceId, workspaceId),
        eq(deliveries.agentId, agentId),
      ),
    );
  return row ?? null;
}

async function reloadDelivery(db: Db, deliveryId: string): Promise<DeliveryRow> {
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  return row;
}

/**
 * Idempotently transition a delivery to `delivered`. Repeated calls return the
 * same delivered record. Returns null if the delivery is not found / not owned.
 */
export async function ackDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
) {
  const existing = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  if (!existing) return null;

  if (existing.status !== 'delivered') {
    await db
      .update(deliveries)
      .set({ status: 'delivered', updatedAt: new Date() })
      .where(eq(deliveries.id, deliveryId));
  }
  return serializeDelivery(await reloadDelivery(db, deliveryId));
}

/**
 * Idempotently record a delivery as `failed`, capturing error text and
 * retryability. Returns null if the delivery is not found / not owned.
 */
export async function failDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
  opts: { error?: string; retryable?: boolean } = {},
) {
  const existing = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  if (!existing) return null;

  await db
    .update(deliveries)
    .set({
      status: 'failed',
      error: opts.error ?? null,
      retryable: opts.retryable ?? null,
      updatedAt: new Date(),
    })
    .where(eq(deliveries.id, deliveryId));
  return serializeDelivery(await reloadDelivery(db, deliveryId));
}

/**
 * Idempotently record a delivery as `deferred` with the time it next becomes
 * available. Returns null if the delivery is not found / not owned.
 */
export async function deferDelivery(
  db: Db,
  workspaceId: string,
  agentId: string,
  deliveryId: string,
  opts: { availableAt: Date; reason?: string },
) {
  const existing = await getOwnedDelivery(db, workspaceId, agentId, deliveryId);
  if (!existing) return null;

  await db
    .update(deliveries)
    .set({
      status: 'deferred',
      availableAt: opts.availableAt,
      reason: opts.reason ?? existing.reason,
      updatedAt: new Date(),
    })
    .where(eq(deliveries.id, deliveryId));
  return serializeDelivery(await reloadDelivery(db, deliveryId));
}
