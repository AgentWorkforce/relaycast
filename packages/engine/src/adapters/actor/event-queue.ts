import type { EventQueue, QueuedEvent } from '../../ports/event-queue.js';
import type { EngineDb } from '../../ports/database.js';
import { enqueueEvent } from '../../engine/eventQueue.js';
import { DurableEventQueue, type DurableEventQueueOptions } from '../node/event-queue.js';

/**
 * Webhook outbox for a workspace actor.
 *
 * `send` only makes the event durable (the request path already inserted the
 * `pending_events` row when `outboxId` is set) and asks for maintenance. It
 * never delivers: an actor call holds the actor's mailbox until it returns,
 * so outbound HTTP runs from `drain()`, which the actor's alarm calls.
 */
export class ActorEventQueue implements EventQueue {
  private readonly outbox: DurableEventQueue;

  constructor(
    private readonly db: EngineDb,
    private readonly requestMaintenance: () => void,
    onError: (err: unknown, ctx: Record<string, unknown>) => void,
    options: Omit<DurableEventQueueOptions, 'pollIntervalMs'> & { fetch: typeof globalThis.fetch },
  ) {
    this.outbox = new DurableEventQueue(db, onError, { ...options, pollIntervalMs: 0 });
  }

  async send(message: QueuedEvent): Promise<void> {
    if (!message.outboxId) {
      await enqueueEvent(this.db, message.workspaceId, message.type, message.data);
    }
    this.requestMaintenance();
  }

  /** Deliver every due outbox row and prune settled ones on the outbox's cadence. */
  drain(): Promise<void> {
    return this.outbox.poll();
  }
}
