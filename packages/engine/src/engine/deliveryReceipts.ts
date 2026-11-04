import { and, eq, inArray } from 'drizzle-orm';
import { agents, deliveries, messages } from '../db/schema.js';
import { queryInChunks } from '../lib/queryChunks.js';
import { toIso } from '../lib/serialize.js';
import { publishEventsToAgents, type EventDispatchDeps } from './eventDispatch.js';

/** The two delivery transitions a sender is told about. */
export type SenderDeliveryReceiptStatus = 'delivered' | 'acked';

/**
 * Tell each message sender that one of its deliveries moved to `status`:
 * `delivery.delivered` when the row was handed to the recipient (`queued` ->
 * `delivered`), `delivery.acked` when the recipient acknowledged it. The event
 * reaches the sender through the agent-scoped dispatch path (workspace stream
 * plus the sender's node as a `context.update`).
 *
 * One read resolves every row in the batch (sender, recipient name and the
 * transition timestamp), chunked under D1's bound-parameter cap; nothing is
 * read per row. Rows with no sender agent (workspace-key or system posts) and
 * self-addressed rows are skipped. A `delivered` receipt is also dropped for a
 * row that has already left `delivered` by the time the batch is read: a
 * routing pass reports its batch only after every recipient settles, and a
 * fast recipient can ack in between, so the late `delivered` would land after
 * the sender's `delivery.acked` and roll its view back. Best-effort: a failure
 * here never fails the transition that triggered it.
 */
export async function notifySenderDeliveryReceipts(
  deps: EventDispatchDeps,
  workspaceId: string,
  deliveryIds: readonly string[],
  status: SenderDeliveryReceiptStatus,
): Promise<void> {
  const ids = [...new Set(deliveryIds)];
  if (ids.length === 0) return;
  const rows = await queryInChunks(ids, (chunk) => deps.db
    .select({
      id: deliveries.id,
      messageId: deliveries.messageId,
      recipientId: deliveries.agentId,
      recipientName: agents.name,
      senderId: messages.agentId,
      status: deliveries.status,
      deliveredAt: deliveries.deliveredAt,
      ackedAt: deliveries.ackedAt,
    })
    .from(deliveries)
    .innerJoin(messages, eq(deliveries.messageId, messages.id))
    .innerJoin(agents, eq(deliveries.agentId, agents.id))
    .where(and(eq(deliveries.workspaceId, workspaceId), inArray(deliveries.id, chunk))));

  const fallbackAt = new Date().toISOString();
  const events = rows
    .filter((row) => row.senderId !== null && row.senderId !== row.recipientId)
    .filter((row) => status !== 'delivered' || row.status === 'delivered')
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
        at: toIso(status === 'acked' ? row.ackedAt : row.deliveredAt) ?? fallbackAt,
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
