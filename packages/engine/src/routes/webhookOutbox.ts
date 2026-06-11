import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import type { QueuedEvent } from '../ports/event-queue.js';
import { enqueueEvent } from '../engine/eventQueue.js';
import { hasActiveSubscriptions } from '../engine/eventSubscription.js';
import { runInBackground } from './background.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';

/**
 * Persist-first webhook enqueue.
 *
 * Skips entirely when the workspace has no active event subscription —
 * webhook events fan out exclusively to `event_subscriptions` rows, so with
 * none configured the outbox INSERT and queue send would both be guaranteed
 * no-ops. The existence probe is memoized per request (`webhookSubscribersExist`
 * context variable) since a single mutation can emit several events, and fails
 * open: if the probe errors, the event is enqueued as usual.
 *
 * Otherwise inserts the `pending_events` outbox row synchronously in the
 * request path (single cheap INSERT — the event is durable once this
 * resolves), then hands the row id to the EventQueue adapter in the
 * background. If the adapter's send is lost (Workers isolate dies after the
 * response, queue outage), the row stays `pending` and `sweepPendingEvents`
 * re-enqueues it later, so the event survives instead of vanishing.
 *
 * If the outbox insert itself fails, the route still responds normally and the
 * event degrades to the legacy fire-and-forget queue send (no `outboxId`) —
 * a webhook should never fail the mutation that triggered it.
 */
export async function sendWebhookEvent(c: Context<AppEnv>, event: QueuedEvent): Promise<void> {
  try {
    let subscribersExist = c.get('webhookSubscribersExist');
    if (subscribersExist === undefined) {
      subscribersExist = await hasActiveSubscriptions(c.get('db'), event.workspaceId);
      c.set('webhookSubscribersExist', subscribersExist);
    }
    if (!subscribersExist) return;
  } catch (error) {
    // Fail open: a broken probe must not drop events for subscribed workspaces.
    getRequestLogger(c, 'webhook.outbox').warn(`subscription probe failed for ${event.type}`, {
      ...toErrorDetails(error),
    });
  }

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
