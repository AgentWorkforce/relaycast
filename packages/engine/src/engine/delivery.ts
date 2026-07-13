import { eq, and, or, not, asc, isNull, inArray, notInArray, lte, gt, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { deliveries, messages, agents, readReceipts, channelMembers, channels, dmConversations } from '../db/schema.js';
import type { DeliveryStatus } from '@relaycast/types';
import { runAtomic } from '../ports/database.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { isProviderAgentDeliveryReady } from '../ports/realtime.js';
import { buildDeliverFrame, buildDeliverPayload, buildMessageCreatedEventData, buildThreadReplyEventData, buildDmReceivedEventData, buildGroupDmReceivedEventData } from './deliveryWire.js';
import { publicMessageMetadata } from './messageMetadata.js';
import { toIso } from '../lib/serialize.js';
import { fetchAttachmentsBatch, type AttachmentRow } from './attachments.js';
import type { DeliveryFanoutRecord } from './deliveryWrites.js';

type Db = ReturnType<typeof getDb>;

type DeliveryRow = typeof deliveries.$inferSelect;
type DeliveryWithChannel = DeliveryRow & { channelId: string };
type PendingDeliveryRow = {
  delivery: DeliveryRow;
  recipientAgentName: string;
  body: string;
  blocks: unknown;
  metadata: unknown;
  hasAttachments: boolean;
  threadId: string | null;
  createdAt: Date;
  channelId: string;
  channelName: string;
  conversationId: string | null;
  dmType: string | null;
  senderAgentId: string | null;
  senderAgentName: string | null;
};

export interface RoutableDeliveryEvent {
  workspaceId: string;
  delivery: DeliveryFanoutRecord;
  eventType: string;
  eventData: Record<string, unknown>;
}

const ACTIVE_DELIVERY_STATUSES = ['queued', 'delivered'] as const;
const TERMINAL_SUCCESS_STATUS = 'acked';
// Keep expiry work bounded per request and leave ample room under D1's
// 100-parameter ceiling for the UPDATE's SET and status/workspace predicates.
// A larger backlog drains oldest-first across subsequent inbox/delivery reads.
const DELIVERY_EXPIRY_BATCH_SIZE = 50;

function serializeDelivery(row: DeliveryRow & { channelId?: string }) {
  return {
    id: row.id,
    message_id: row.messageId,
    channel_id: row.channelId ?? '',
    agent_id: row.agentId,
    status: row.status as DeliveryStatus,
    seq: row.seq,
    location_type: row.locationType,
    location_node_id: row.locationNodeId,
    route_node_id: row.routeNodeId,
    route_node_kind: row.routeNodeKind,
    route_node_role: row.routeNodeRole,
    delivery_adapter: row.deliveryAdapter,
    dispatch_attempts: row.dispatchAttempts,
    next_attempt_at: toIso(row.nextAttemptAt),
    last_dispatch_error: row.lastDispatchError,
    mode: row.mode,
    reason: row.reason,
    priority: row.priority,
    retryable: row.retryable ?? null,
    error: row.error,
    available_at: toIso(row.availableAt),
    deadline: toIso(row.deadline),
    expires_at: toIso(row.expiresAt),
    delivered_at: toIso(row.deliveredAt),
    acked_at: toIso(row.ackedAt),
    dead_lettered_at: toIso(row.deadLetteredAt),
    created_at: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updated_at: toIso(row.updatedAt),
  };
}


/**
 * List durable delivery items for an agent. Defaults to the non-terminal
 * (`queued` + `delivered`) queue so an offline consumer can replay what it
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
    : inArray(deliveries.status, [...ACTIVE_DELIVERY_STATUSES]);
  // A bounded workspace sweep may spend its batch on another agent's older
  // backlog. Never expose this agent's still-unswept expired rows through the
  // default active queue; explicit status queries continue to reflect stored state.
  const activeExpiryFilter = opts.status
    ? undefined
    : sql`(${deliveries.expiresAt} IS NULL OR ${deliveries.expiresAt} > ${Math.floor(Date.now() / 1000)})`;

  const rows = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.workspaceId, workspaceId),
        eq(deliveries.agentId, agentId),
        statusFilter,
        activeExpiryFilter,
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
): Promise<DeliveryWithChannel | null> {
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
 * Idempotently transition a delivery to `acked`. `acked` is terminal,
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
  if (existing.status === TERMINAL_SUCCESS_STATUS) return { delivery: serializeDelivery(existing), changed: false };

  // A single per-delivery ack may be out of order (e.g. acking seq 2 while seq 1
  // is still queued). Mark this row acked but do NOT advance the cumulative
  // cursor — `deliverPendingToNode` filters `seq > delivery_ack_seq`, so an
  // over-advanced cursor would skip the lower unacked row forever on node
  // replay. The row's `acked` status already excludes it from replay.
  const [updated] = await ackRows(db, workspaceId, agentId, [existing]);
  return resolveTransition(db, workspaceId, agentId, deliveryId, updated, existing.channelId);
}

/**
 * Idempotently record a delivery as `failed`, capturing error text and
 * retryability. `acked`, `dead_lettered`, and `failed` are treated as settled: once a
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
  if (['acked', 'dead_lettered', 'failed'].includes(existing.status)) {
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
    .where(and(eq(deliveries.id, deliveryId), notInArray(deliveries.status, ['acked', 'dead_lettered', 'failed'])))
    .returning();
  return resolveTransition(db, workspaceId, agentId, deliveryId, updated, existing.channelId);
}

/**
 * Compatibility shim for the old defer endpoint. The durable state remains
 * `queued`; `available_at` gates client-side retries. A re-defer to the same
 * `available_at`/reason is a no-op (reported as `changed: false`). `acked`
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
  if (['acked', 'dead_lettered'].includes(existing.status)) {
    return { delivery: serializeDelivery(existing), changed: false };
  }

  // The defer reason is its own concept; don't inherit the acceptance reason
  // (message/mention/dm/...) when the caller omits one, or deferred records and
  // delivery.deferred events would carry a misleading reason. Default to null.
  const targetReason = opts.reason ?? null;
  const reasonMatches = targetReason === null
    ? isNull(deliveries.reason)
    : eq(deliveries.reason, targetReason);
  // A real change means: not terminal-delivered, and not already deferred to
  // this exact (available_at, reason). Encoding the no-op predicate in the
  // UPDATE makes it atomic — identical concurrent defers match no row on the
  // loser and report `changed: false`, so no duplicate event fires.
  const isNoop = and(
    eq(deliveries.status, 'queued'),
    eq(deliveries.availableAt, opts.availableAt),
    reasonMatches,
  )!;
  const [updated] = await db
    .update(deliveries)
    .set({
      status: 'queued',
      availableAt: opts.availableAt,
      reason: targetReason,
      updatedAt: new Date(),
    })
    .where(and(
      eq(deliveries.id, deliveryId),
      notInArray(deliveries.status, ['acked', 'dead_lettered']),
      not(isNoop),
    ))
    .returning();
  return resolveTransition(db, workspaceId, agentId, deliveryId, updated, existing.channelId);
}

async function markRowsRead(tx: Db, agentId: string, rows: DeliveryWithChannel[]) {
  for (const row of rows) {
    await tx
      .insert(readReceipts)
      .values({ messageId: row.messageId, agentId })
      .onConflictDoNothing();

    await tx
      .update(channelMembers)
      .set({ lastReadId: row.messageId })
      .where(and(
        eq(channelMembers.channelId, row.channelId),
        eq(channelMembers.agentId, agentId),
        sql`(${channelMembers.lastReadId} IS NULL OR CAST(${channelMembers.lastReadId} AS BIGINT) < CAST(${row.messageId} AS BIGINT))`,
      ));
  }
}

async function ackRows(
  db: Db,
  workspaceId: string,
  agentId: string,
  rows: DeliveryWithChannel[],
  // Cumulative cursor target. Pass the contiguous up-to-seq only for a genuine
  // cumulative ack (the node `delivery.ack {up_to_seq}` path). Omit for single /
  // out-of-order acks so the cursor is never advanced past a still-unacked
  // lower-seq row (which `deliverPendingToNode` would then skip forever).
  advanceCursorTo?: number,
): Promise<DeliveryRow[]> {
  const ids = rows.map((row) => row.id);
  return runAtomic(db, async (tx) => {
    await tx
      .update(agents)
      .set({
        deliveryAckSeq:
          advanceCursorTo === undefined
            ? sql<number>`${agents.deliveryAckSeq}`
            : sql<number>`CASE
              WHEN ${agents.deliveryAckSeq} < ${advanceCursorTo} THEN ${advanceCursorTo}
              ELSE ${agents.deliveryAckSeq}
            END`,
        lastSeen: new Date(),
      })
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));

    const updated = ids.length > 0
      ? await tx
        .update(deliveries)
        .set({
          status: TERMINAL_SUCCESS_STATUS,
          nextAttemptAt: null,
          lastDispatchError: null,
          ackedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(deliveries.workspaceId, workspaceId),
          inArray(deliveries.id, ids),
          notInArray(deliveries.status, ['acked', 'dead_lettered']),
        ))
        .returning()
      : [];

    if (rows.length > 0) await markRowsRead(tx, agentId, rows);
    return updated;
  });
}

export async function ackDeliveriesUpToSeq(
  db: Db,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  agentName: string,
  upToSeq: number,
): Promise<{ agent_id: string; agent_name: string; up_to_seq: number; acked: number } | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.name, agentName),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodeId),
      eq(agents.providerName, providerName),
    ));
  if (!agent) return null;

  if (upToSeq <= agent.deliveryAckSeq) {
    return { agent_id: agent.id, agent_name: agent.name, up_to_seq: upToSeq, acked: 0 };
  }

  const rows = await db
    .select({ delivery: deliveries, channelId: messages.channelId })
    .from(deliveries)
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .where(and(
      eq(deliveries.workspaceId, workspaceId),
      eq(deliveries.agentId, agent.id),
      lte(deliveries.seq, upToSeq),
      notInArray(deliveries.status, ['acked', 'dead_lettered']),
    ))
    .orderBy(asc(deliveries.seq));

  const updated = await ackRows(
    db,
    workspaceId,
    agent.id,
    rows.map((row) => ({ ...row.delivery, channelId: row.channelId })),
    upToSeq,
  );
  return { agent_id: agent.id, agent_name: agent.name, up_to_seq: upToSeq, acked: updated.length };
}

export async function markDeliveriesDelivered(
  db: Db,
  workspaceId: string,
  deliveryIds: string[],
): Promise<number> {
  if (deliveryIds.length === 0) return 0;
  const updated = await db
    .update(deliveries)
    .set({
      status: 'delivered',
      nextAttemptAt: null,
      lastDispatchError: null,
      deliveredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(deliveries.workspaceId, workspaceId),
      inArray(deliveries.id, deliveryIds),
      eq(deliveries.status, 'queued'),
    ))
    .returning();
  return updated.length;
}

export interface DeliveryFailureNotice {
  workspace_id: string;
  delivery_id: string;
  message_id: string;
  sender_agent_id: string;
  target_agent_id: string;
  target_agent_name: string;
  seq: number;
  reason: 'ttl_expired';
  error: string;
  retryable: false;
}

export async function expireDueDeliveries(
  db: Db,
  workspaceId: string | undefined,
  now: Date = new Date(),
): Promise<DeliveryFailureNotice[]> {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const due = await db
    .select({
      delivery: deliveries,
      senderAgentId: messages.agentId,
      targetAgentName: agents.name,
    })
    .from(deliveries)
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .innerJoin(agents, eq(deliveries.agentId, agents.id))
    .where(and(
      workspaceId ? eq(deliveries.workspaceId, workspaceId) : undefined,
      inArray(deliveries.status, [...ACTIVE_DELIVERY_STATUSES]),
      sql`${deliveries.expiresAt} IS NOT NULL AND ${deliveries.expiresAt} <= ${nowSeconds}`,
    ))
    .orderBy(asc(deliveries.expiresAt), asc(deliveries.id))
    .limit(DELIVERY_EXPIRY_BATCH_SIZE);

  if (due.length === 0) return [];

  const ids = due.map((row) => row.delivery.id);
  const updated = await db
    .update(deliveries)
    .set({
      status: 'dead_lettered',
      error: 'delivery TTL expired',
      retryable: false,
      deadLetteredAt: now,
      updatedAt: now,
    })
    .where(and(
      workspaceId ? eq(deliveries.workspaceId, workspaceId) : undefined,
      inArray(deliveries.id, ids),
      notInArray(deliveries.status, ['acked', 'dead_lettered', 'failed']),
    ))
    .returning({ id: deliveries.id });
  const updatedIds = new Set(updated.map((row) => row.id));

  return due
    .filter((row) => row.senderAgentId && updatedIds.has(row.delivery.id))
    .map((row) => ({
      workspace_id: row.delivery.workspaceId,
      delivery_id: row.delivery.id,
      message_id: row.delivery.messageId,
      sender_agent_id: row.senderAgentId,
      target_agent_id: row.delivery.agentId,
      target_agent_name: row.targetAgentName,
      seq: row.delivery.seq,
      reason: 'ttl_expired' as const,
      error: 'delivery TTL expired',
      retryable: false as const,
    }));
}

function wireMode(mode: string): 'wait' | 'steer' {
  return mode === 'next-tool-call' ? 'steer' : 'wait';
}

function buildRoutableDeliveryEvent(
  row: PendingDeliveryRow,
  attachments: AttachmentRow[],
): { eventType: string; eventData: Record<string, unknown> } {
  const senderName = row.senderAgentName ?? 'unknown';
  const injectionMode = row.delivery.mode === 'next-tool-call' ? 'steer' : 'wait';
  // Thread replies route as `thread.reply` in the live path even inside a DM /
  // group DM (see routes/thread.ts fanout), so a missed thread reply must
  // replay with the same event type/shape. Check `threadId` before `dmType`.
  const eventType = row.threadId
    ? 'thread.reply'
    : (row.dmType
      ? (row.dmType === 'group' ? 'group_dm.received' : 'dm.received')
      : 'message.created');

  if (eventType === 'dm.received') {
    return {
      eventType,
      eventData: buildDmReceivedEventData({
        conversation_id: row.conversationId,
        message: {
          id: row.delivery.messageId,
          agent_id: row.senderAgentId,
          agent_name: senderName,
          text: row.body,
          injection_mode: injectionMode,
          attachments,
        },
        created_at: row.createdAt.toISOString(),
        id: row.delivery.messageId,
        from_agent_id: row.senderAgentId,
        to: row.recipientAgentName,
        text: row.body,
        injection_mode: injectionMode,
        attachments,
      }, { fromName: senderName }),
    };
  }

  if (eventType === 'group_dm.received') {
    return {
      eventType,
      eventData: buildGroupDmReceivedEventData({
        conversation_id: row.conversationId,
        message: {
          id: row.delivery.messageId,
          agent_id: row.senderAgentId,
          agent_name: senderName,
          text: row.body,
          injection_mode: injectionMode,
          attachments,
        },
        created_at: row.createdAt.toISOString(),
        id: row.delivery.messageId,
        agent_id: row.senderAgentId,
        text: row.body,
        injection_mode: injectionMode,
        attachments,
      }, { fromName: senderName }),
    };
  }

  if (eventType === 'thread.reply') {
    return {
      eventType,
      eventData: buildThreadReplyEventData({
        id: row.delivery.messageId,
        channel_id: row.channelId,
        channel_name: row.channelName,
        agent_id: row.senderAgentId,
        agent_name: senderName,
        thread_id: row.threadId,
        text: row.body,
        blocks: (row.blocks as unknown[] | null) || null,
        metadata: publicMessageMetadata(row.metadata as Record<string, unknown> | null),
        has_attachments: row.hasAttachments,
        created_at: row.createdAt.toISOString(),
      }, { channelName: row.channelName, fromName: senderName }),
    };
  }

  const mentions = [...row.body.matchAll(/@(\w+)/g)].map((match) => match[1]);
  return {
    eventType,
    eventData: buildMessageCreatedEventData({
      id: row.delivery.messageId,
      channel_id: row.channelId,
      agent_id: row.senderAgentId,
      agent_name: senderName,
      text: row.body,
      blocks: (row.blocks as unknown[] | null) || null,
      metadata: publicMessageMetadata(row.metadata as Record<string, unknown> | null),
      has_attachments: row.hasAttachments,
      thread_id: row.threadId,
      created_at: row.createdAt.toISOString(),
      mentions,
      attachments,
      injection_mode: injectionMode,
    }, { channelName: row.channelName, fromName: senderName, mode: injectionMode }),
  };
}

function fanoutRecordFromDeliveryRow(row: PendingDeliveryRow): DeliveryFanoutRecord {
  return {
    id: row.delivery.id,
    agentId: row.delivery.agentId,
    agentName: row.recipientAgentName,
    messageId: row.delivery.messageId,
    seq: row.delivery.seq,
    mode: row.delivery.mode,
    reason: row.delivery.reason ?? 'message',
    status: row.delivery.status,
    locationType: row.delivery.locationType,
    locationNodeId: row.delivery.locationNodeId,
    routeNodeId: row.delivery.routeNodeId,
    routeNodeKind: row.delivery.routeNodeKind,
    routeNodeRole: row.delivery.routeNodeRole,
    deliveryAdapter: row.delivery.deliveryAdapter,
    nextAttemptAt: row.delivery.nextAttemptAt,
  };
}

export async function fetchDueHttpPushDeliveryEvents(
  db: Db,
  opts: { workspaceId?: string; now?: Date; limit?: number } = {},
): Promise<RoutableDeliveryEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const now = opts.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const conditions = [
    eq(deliveries.status, 'queued'),
    eq(deliveries.routeNodeKind, 'http_push'),
    // Match deliveries that are EITHER never-attempted (nextAttemptAt IS NULL —
    // e.g. the inline send-time push never ran or its waitUntil was lost) OR due
    // for retry (nextAttemptAt <= now). Without the NULL branch the cron could
    // only ever *retry* deliveries that already had an inline attempt (the inline
    // dispatch is what first stamps nextAttemptAt); a fresh http_push delivery
    // whose inline push never fired would sit queued forever and never reach the
    // webhook — an http_push agent never "comes online" to pull it, so the cron
    // is its only guaranteed delivery path.
    or(isNull(deliveries.nextAttemptAt), lte(deliveries.nextAttemptAt, now)),
    sql`(${deliveries.expiresAt} IS NULL OR ${deliveries.expiresAt} > ${nowSeconds})`,
  ];
  if (opts.workspaceId) {
    conditions.push(eq(deliveries.workspaceId, opts.workspaceId));
  }

  const rows = await db
    .select({
      delivery: deliveries,
      recipientAgentName: agents.name,
      body: messages.body,
      blocks: messages.blocks,
      metadata: messages.metadata,
      hasAttachments: messages.hasAttachments,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      channelId: messages.channelId,
      channelName: channels.name,
      conversationId: dmConversations.id,
      dmType: dmConversations.dmType,
      senderAgentId: messages.agentId,
      senderAgentName: sql<string | null>`(
        SELECT a.name FROM agents a WHERE a.id = ${messages.agentId}
      )`,
    })
    .from(deliveries)
    .innerJoin(agents, eq(deliveries.agentId, agents.id))
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(dmConversations, eq(dmConversations.channelId, messages.channelId))
    .where(and(...conditions))
    .orderBy(asc(deliveries.nextAttemptAt), asc(deliveries.createdAt), asc(deliveries.id))
    .limit(limit);

  if (!opts.workspaceId && rows.length > 0) {
    const workspaceAttachments = new Map<string, AttachmentRow[]>();
    for (const workspaceId of [...new Set(rows.map((row) => row.delivery.workspaceId))]) {
      const workspaceMessageIds = rows
        .filter((row) => row.delivery.workspaceId === workspaceId)
        .map((row) => row.delivery.messageId);
      const batch = await fetchAttachmentsBatch(db, workspaceId, [...new Set(workspaceMessageIds)]);
      for (const [messageId, attachments] of batch) workspaceAttachments.set(messageId, attachments);
    }
    return rows.map((row) => {
      const pendingRow = row as PendingDeliveryRow;
      const { eventType, eventData } = buildRoutableDeliveryEvent(
        pendingRow,
        workspaceAttachments.get(row.delivery.messageId) ?? [],
      );
      return {
        workspaceId: row.delivery.workspaceId,
        delivery: fanoutRecordFromDeliveryRow(pendingRow),
        eventType,
        eventData,
      };
    });
  }

  const attachmentsByMessageId = opts.workspaceId
    ? await fetchAttachmentsBatch(db, opts.workspaceId, [...new Set(rows.map((row) => row.delivery.messageId))])
    : new Map<string, AttachmentRow[]>();

  return rows.map((row) => {
    const pendingRow = row as PendingDeliveryRow;
    const { eventType, eventData } = buildRoutableDeliveryEvent(
      pendingRow,
      attachmentsByMessageId.get(row.delivery.messageId) ?? [],
    );
    return {
      workspaceId: row.delivery.workspaceId,
      delivery: fanoutRecordFromDeliveryRow(pendingRow),
      eventType,
      eventData,
    };
  });
}

export interface NodeDeliveryReplayScope {
  /** Limit replay to agents registered through this provider connection. */
  providerName?: string;
  /** Limit replay to identities whose broker-side cursor is ready. */
  agentIds?: readonly string[];
}

export async function deliverPendingToNode(
  db: Db,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  scope: NodeDeliveryReplayScope = {},
): Promise<number> {
  const agentIds = scope.agentIds ? [...new Set(scope.agentIds)] : undefined;
  if (agentIds?.length === 0) return 0;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const conditions = [
    eq(deliveries.workspaceId, workspaceId),
    eq(agents.locationType, 'via_node'),
    eq(agents.locationNodeId, nodeId),
    inArray(deliveries.status, [...ACTIVE_DELIVERY_STATUSES]),
    gt(deliveries.seq, agents.deliveryAckSeq),
    sql`(${deliveries.expiresAt} IS NULL OR ${deliveries.expiresAt} > ${nowSeconds})`,
  ];
  if (scope.providerName !== undefined) {
    conditions.push(eq(agents.providerName, scope.providerName));
  }
  if (agentIds) {
    conditions.push(inArray(agents.id, agentIds));
  }

  const rows = await db
    .select({
      delivery: deliveries,
      recipientAgentName: agents.name,
      recipientProviderName: agents.providerName,
      ackSeq: agents.deliveryAckSeq,
      body: messages.body,
      blocks: messages.blocks,
      metadata: messages.metadata,
      hasAttachments: messages.hasAttachments,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      channelId: messages.channelId,
      channelName: channels.name,
      conversationId: dmConversations.id,
      dmType: dmConversations.dmType,
      senderAgentId: messages.agentId,
      senderAgentName: sql<string | null>`(
        SELECT a.name FROM agents a WHERE a.id = ${messages.agentId}
      )`,
    })
    .from(deliveries)
    .innerJoin(agents, eq(deliveries.agentId, agents.id))
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(dmConversations, eq(dmConversations.channelId, messages.channelId))
    .where(and(...conditions))
    .orderBy(asc(agents.name), asc(deliveries.seq));

  const attachmentsByMessageId = await fetchAttachmentsBatch(db, workspaceId, [...new Set(rows.map((row) => row.delivery.messageId))]);

  const deliveredIds: string[] = [];
  for (const row of rows) {
    if (!isProviderAgentDeliveryReady(
      registry,
      workspaceId,
      nodeId,
      row.recipientProviderName,
      row.delivery.agentId,
    )) {
      continue;
    }
    const attachments = attachmentsByMessageId.get(row.delivery.messageId) ?? [];
    const { eventType, eventData } = buildRoutableDeliveryEvent(row, attachments);

    const sent = await registry.sendToProvider(workspaceId, nodeId, row.recipientProviderName, buildDeliverFrame({
      delivery_id: row.delivery.id,
      agent_id: row.delivery.agentId,
      agent: row.recipientAgentName,
      msg_id: row.delivery.messageId,
      seq: row.delivery.seq,
      mode: wireMode(row.delivery.mode),
      payload: buildDeliverPayload(eventType, eventData),
    }));
    if (sent) deliveredIds.push(row.delivery.id);
  }

  await markDeliveriesDelivered(db, workspaceId, deliveredIds);
  return deliveredIds.length;
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
