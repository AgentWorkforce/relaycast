import type { EventQueue, QueuedEvent } from '../../ports/event-queue.js';
import type { EngineDb } from '../../ports/database.js';
import { deliverEvent } from '../../engine/eventDelivery.js';

/**
 * In-process webhook delivery, replacing the Cloudflare Queue + consumer Worker.
 * `send` returns immediately and delivery runs in the background via
 * `deliverEvent` (which fans out to the workspace's registered subscribers).
 * Single-process best-effort: failures are logged, not retried across restarts.
 */
export class InProcessEventQueue implements EventQueue {
  constructor(
    private readonly db: EngineDb,
    private readonly onError: (err: unknown, ctx: Record<string, unknown>) => void = () => {},
  ) {}

  async send(message: QueuedEvent): Promise<void> {
    // Fire-and-forget; do not block the request path on delivery.
    void (async () => {
      try {
        await deliverEvent(this.db, message.workspaceId, message.type, message.data);
      } catch (err) {
        this.onError(err, { source: 'node.event_queue', event_type: message.type });
      }
    })();
  }
}
