/**
 * Outbound event queue port — replaces the Cloudflare `WEBHOOK_QUEUE` binding.
 *
 * After a mutation, routes persist a `pending_events` outbox row in the request
 * path (`routes/webhookOutbox.ts`), then enqueue a delivery message carrying the
 * row id; the consumer fans it out to the workspace's registered webhook
 * subscribers (`engine/eventDelivery.ts`) and settles the row. On Cloudflare
 * this is a Queue producer + a separate consumer Worker. The Node adapter
 * implements it as a poller over the same outbox table.
 */
export interface QueuedEvent {
  type: string;
  workspaceId: string;
  data: Record<string, unknown>;
  /**
   * Id of the pre-inserted `pending_events` outbox row backing this event.
   *
   * Semantics for adapters:
   * - Present: the row is already durable. Do NOT insert another row. After
   *   delivery, the consumer settles it — `completeEvent` on success,
   *   `failEvent` on terminal failure, `rescheduleEvent` to defer. Rows left
   *   unsettled (lost queue send, crashed consumer) become due again and are
   *   re-enqueued by `sweepPendingEvents`.
   * - Absent (legacy callers): the adapter owns durability itself. The Node
   *   adapter inserts the row before returning; queue-backed adapters degrade
   *   to fire-and-forget for that event.
   */
  outboxId?: string;
}

export interface EventQueue {
  /** Enqueue an event for asynchronous webhook delivery. Returns once accepted. */
  send(message: QueuedEvent): Promise<void>;
}
