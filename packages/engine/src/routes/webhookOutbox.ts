import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import type { QueuedEvent } from '../ports/event-queue.js';
import { enqueueEvent } from '../engine/eventQueue.js';
import { runInBackground } from './background.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';

/**
 * Persist-first webhook enqueue.
 *
 * Inserts the `pending_events` outbox row synchronously in the request path
 * (single cheap INSERT — the event is durable once this resolves), then hands
 * the row id to the EventQueue adapter in the background. If the adapter's
 * send is lost (Workers isolate dies after the response, queue outage), the
 * row stays `pending` and `sweepPendingEvents` re-enqueues it later, so the
 * event survives instead of vanishing.
 *
 * If the outbox insert itself fails, the route still responds normally and the
 * event degrades to the legacy fire-and-forget queue send (no `outboxId`) —
 * a webhook should never fail the mutation that triggered it.
 */
export async function sendWebhookEvent(c: Context<AppEnv>, event: QueuedEvent): Promise<void> {
  let outboxId: string | undefined;
  try {
    outboxId = await enqueueEvent(c.get('db'), event.workspaceId, event.type, event.data);
  } catch (error) {
    getRequestLogger(c, 'webhook.outbox').error(`outbox insert failed for ${event.type}`, {
      ...toErrorDetails(error),
    });
  }
  // Async wrapper so a synchronously-throwing adapter rejects in the
  // background (logged by runInBackground) instead of failing the request.
  const queued = outboxId ? { ...event, outboxId } : event;
  runInBackground(
    c,
    (async () => c.get('engine').webhookQueue.send(queued))(),
    `queue ${event.type}`,
  );
}
