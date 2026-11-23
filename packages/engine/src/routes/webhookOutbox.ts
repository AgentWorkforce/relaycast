import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import type { QueuedEvent } from '../ports/event-queue.js';
import { enqueueEvent } from '../engine/eventQueue.js';
import {
  subscriptionWantsEvent,
  withStoredRecipients,
  type WebhookRecipient,
} from '../engine/eventDelivery.js';
import { listActiveSubscriptionMatchers, type SubscriptionMatcher } from '../engine/eventSubscription.js';
import { runInBackground } from './background.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';

/** A delivery record as the engine returns it (`_deliveries` / `_delivery`). */
export interface WebhookRecipientSource {
  id?: string | null;
  agentId: string;
  agentName: string;
  seq?: number | null;
}

/** `data.recipients` entries; webhook payloads only, never WS/stream/HTTP. */
export function toWebhookRecipients(records: readonly WebhookRecipientSource[]): WebhookRecipient[] {
  return records.map((record) => ({
    agent_id: record.agentId,
    agent_name: record.agentName,
    ...(record.id ? { delivery_id: record.id } : {}),
    ...(typeof record.seq === 'number' ? { seq: record.seq } : {}),
  }));
}

async function subscriptionMatchers(
  c: Context<AppEnv>,
  workspaceId: string,
  eventType: string,
): Promise<SubscriptionMatcher[] | null> {
  const cached = c.get('webhookSubscriptionMatchers');
  if (cached !== undefined) return cached;
  let matchers: SubscriptionMatcher[] | null;
  try {
    matchers = await listActiveSubscriptionMatchers(c.get('db'), workspaceId);
  } catch (error) {
    // Fail open: a broken read must not drop events for subscribed workspaces.
    // Cached too, so a failing read is not retried for every event of the request.
    getRequestLogger(c, 'webhook.outbox').warn(`subscription probe failed for ${eventType}`, {
      ...toErrorDetails(error),
    });
    matchers = null;
  }
  c.set('webhookSubscriptionMatchers', matchers);
  return matchers;
}

/**
 * Persist-first webhook enqueue.
 *
 * Skips entirely when no active subscription wants the event: webhook events
 * fan out exclusively to `event_subscriptions` rows, and the consumer applies
 * the same `subscriptionWantsEvent` check, so the outbox INSERT and queue send
 * would be guaranteed no-ops. The trade-off: a subscription created (or
 * edited) after the send but before the consumer runs misses that event. The
 * subscriptions' `events`/`filter` are read once per request
 * (`webhookSubscriptionMatchers` context variable), since a single mutation can
 * emit several events, and the check fails open (enqueues) when that read
 * errors or exceeds its row bound.
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
export async function webhookEventMatcher(
  c: Context<AppEnv>,
  workspaceId: string,
  eventType: string,
): Promise<(data: Record<string, unknown>) => boolean> {
  const matchers = await subscriptionMatchers(c, workspaceId, eventType);
  return (data) => wantedBy(matchers, eventType, data);
}

function wantedBy(matchers: SubscriptionMatcher[] | null, eventType: string, data: Record<string, unknown>): boolean {
  return matchers === null || matchers.some((matcher) => subscriptionWantsEvent(matcher, eventType, data));
}

/**
 * `recipients` (delivery records of a message event) is added to the webhook
 * payload only: matched in full here, stored bounded, narrowed per target at delivery.
 */
export async function sendWebhookEvent(
  c: Context<AppEnv>,
  event: QueuedEvent,
  recipients?: readonly WebhookRecipientSource[],
): Promise<void> {
  const list = recipients ? toWebhookRecipients(recipients) : undefined;
  const matchers = await subscriptionMatchers(c, event.workspaceId, event.type);
  if (!wantedBy(matchers, event.type, list ? { ...event.data, recipients: list } : event.data)) return;
  const data = list ? withStoredRecipients(event.data, list, matchers, event.type) : event.data;

  let outboxId: string | undefined;
  try {
    outboxId = await enqueueEvent(c.get('db'), event.workspaceId, event.type, data);
  } catch (error) {
    getRequestLogger(c, 'webhook.outbox').error(`outbox insert failed for ${event.type}`, {
      ...toErrorDetails(error),
    });
  }
  // Async wrapper so a synchronously-throwing adapter rejects in the
  // background (logged by runInBackground) instead of failing the request.
  const queued = outboxId ? { ...event, data, outboxId } : { ...event, data };
  runInBackground(
    c,
    (async () => c.get('engine').webhookQueue.send(queued))(),
    `queue ${event.type}`,
  );
}
