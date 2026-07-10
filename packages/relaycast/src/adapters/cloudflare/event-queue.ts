import type { EventQueue, QueuedEvent } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';

/** Cloudflare Queue producer for webhook delivery (consumed by the queue handler). */
export function createCloudflareEventQueue(env: CloudflareBindings): EventQueue {
  return {
    async send(message: QueuedEvent): Promise<void> {
      await env.WEBHOOK_QUEUE.send(message);
    },
  };
}
