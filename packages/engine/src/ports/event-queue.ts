/**
 * Outbound event queue port — replaces the Cloudflare `WEBHOOK_QUEUE` binding.
 *
 * After a mutation, routes enqueue a delivery message; the consumer fans it out
 * to the workspace's registered webhook subscribers (`engine/eventDelivery.ts`).
 * On Cloudflare this is a Queue producer + a separate consumer Worker. The Node
 * adapter implements it as a durable `pending_events` outbox: `send` persists
 * the row, and a background poller delivers via `deliverEvent` with retries
 * that survive restarts.
 */
export interface QueuedEvent {
  type: string;
  workspaceId: string;
  data: Record<string, unknown>;
}

export interface EventQueue {
  /** Enqueue an event for asynchronous webhook delivery. Returns once accepted. */
  send(message: QueuedEvent): Promise<void>;
}
