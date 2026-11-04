import { and, eq, inArray } from 'drizzle-orm';
import { agents, deliveries, messages } from '../db/schema.js';
import { queryInChunks } from '../lib/queryChunks.js';
import { toIso } from '../lib/serialize.js';
import { publishEventsToAgents, type EventDispatchDeps } from './eventDispatch.js';

/** The delivery transitions a sender is told about. */
export type SenderDeliveryReceiptStatus = 'delivered' | 'acked' | 'replied';

/**
 * Tell each message sender that one of its deliveries moved to `status`:
 * `delivery.delivered` when the row was handed to the recipient (`queued` ->
 * `delivered`) or the receiving software accepted it (`accepted: true`),
 * `delivery.acked` when the recipient consumed it, `delivery.replied` when the
 * recipient sent a DM back (`reply_message_id`). The event reaches the sender
 * through the agent-scoped dispatch path (workspace stream plus the sender's
 * node as a `context.update`).
 *
 * One read resolves every row in the batch (sender, recipient name and the
 * transition timestamp), chunked under D1's bound-parameter cap; nothing is
 * read per row. Rows with no sender agent (workspace-key or system posts) and
 * self-addressed rows are skipped. A host-side `delivered` receipt is dropped
 * for a row that has already left `delivered`, or that the receiving software
 * has already accepted, by the time the batch is read: a routing pass reports
 * its batch only after every recipient settles, and a fast recipient can
 * accept or ack in between, so the late `delivered` would land after the
 * sender's stronger receipt and roll its view back. Best-effort: a failure
 * here never fails the transition that triggered it.
 *
 * A send parked on these rows (`wait_ms`) is woken first, whatever `status`.
 */
export async function notifySenderDeliveryReceipts(
  deps: EventDispatchDeps,
  workspaceId: string,
  deliveryIds: readonly string[],
  status: SenderDeliveryReceiptStatus,
  opts: { accepted?: boolean } = {},
): Promise<void> {
  const ids = [...new Set(deliveryIds)];
  if (ids.length === 0) return;
  await wakeDeliveryStateWaiters(deps, workspaceId, ids);
  const rows = await queryInChunks(ids, (chunk) => deps.db
    .select({
      id: deliveries.id,
      messageId: deliveries.messageId,
      recipientId: deliveries.agentId,
      recipientName: agents.name,
      senderId: messages.agentId,
      status: deliveries.status,
      deliveredAt: deliveries.deliveredAt,
      acceptedAt: deliveries.acceptedAt,
      ackedAt: deliveries.ackedAt,
      repliedAt: deliveries.repliedAt,
      replyMessageId: deliveries.replyMessageId,
    })
    .from(deliveries)
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .innerJoin(agents, eq(deliveries.agentId, agents.id))
    .where(and(eq(deliveries.workspaceId, workspaceId), inArray(deliveries.id, chunk))));

  const fallbackAt = new Date().toISOString();
  const events = rows
    .filter((row) => row.senderId !== null && row.senderId !== row.recipientId)
    .filter((row) => status !== 'delivered' || (row.status === 'delivered' && (opts.accepted || row.acceptedAt === null)))
    .filter((row) => status !== 'replied' || row.replyMessageId !== null)
    .map((row) => ({
      workspaceId,
      agentId: row.senderId!,
      type: `delivery.${status}`,
      data: {
        delivery_id: row.id,
        message_id: row.messageId,
        agent_id: row.recipientId,
        agent_name: row.recipientName,
        status,
        ...(status === 'delivered' ? { accepted: row.acceptedAt !== null } : {}),
        ...(status === 'replied' ? { reply_message_id: row.replyMessageId } : {}),
        at: toIso(
          status === 'acked' ? row.ackedAt
            : status === 'replied' ? row.repliedAt
              : (opts.accepted ? row.acceptedAt : row.deliveredAt),
        ) ?? fallbackAt,
      },
    }));
  if (events.length === 0) return;
  await publishEventsToAgents(deps, events, (sink, err) => {
    console.warn(`[delivery.receipt] ${sink} fanout failed for delivery.${status}`, {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Wake sends parked on these rows (`POST /v1/dm` / `POST /v1/channels/:name/messages`
 * with `wait_ms`). Hosts without a waiter have nothing parked. Best-effort: a
 * lost wake costs the parked send latency up to its budget, never a receipt.
 */
export async function wakeDeliveryStateWaiters(
  deps: EventDispatchDeps,
  workspaceId: string,
  deliveryIds: readonly string[],
): Promise<void> {
  const waiters = deps.engine.deliveryWaiters;
  if (!waiters?.notifyDeliveryState || deliveryIds.length === 0) return;
  try {
    await waiters.notifyDeliveryState(workspaceId, deliveryIds);
  } catch (err) {
    console.warn('[delivery.receipt] delivery state waiter notify failed', {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
