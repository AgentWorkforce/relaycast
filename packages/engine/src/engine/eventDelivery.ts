import type { getDb } from '../db/index.js';
import { hmacSha256Hex } from '../lib/crypto.js';
import { getActiveSubscriptions } from './eventSubscription.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

export function signPayload(payload: string, secret: string): Promise<string> {
  return hmacSha256Hex(payload, secret);
}

interface DeliveryTarget {
  url: string;
  secret: string | null;
  headers: Record<string, string> | null;
  filter: { channel?: string; mentions?: string } | null;
}

interface AttemptDeliveryResult {
  ok: boolean;
  retryable: boolean;
}

export interface EventDeliverySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  retryableFailures: number;
}

function publicDeliveryHeaders(headers: Record<string, string> | null): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'content-type' && !lower.startsWith('x-relay-');
    }),
  );
}

function matchesFilter(
  filter: { channel?: string; mentions?: string } | null,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;

  if (filter.channel) {
    const channelName = (payload.channel_name as string) || (payload.channel as string) || '';
    if (!channelName || channelName !== filter.channel) return false;
  }

  if (filter.mentions) {
    const text = (payload.text as string) || '';
    // Use word boundary to avoid matching @bob inside @bobby
    const mentionPattern = new RegExp(`@${filter.mentions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`);
    if (!mentionPattern.test(text)) return false;
  }

  return true;
}

async function attemptDelivery(
  url: string,
  body: string,
  headers: Record<string, string>,
  retries: number = 3,
): Promise<AttemptDeliveryResult> {
  try {
    new Headers(headers);
  } catch {
    return { ok: false, retryable: false };
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        return { ok: true, retryable: false };
      }
      // 4xx errors are not retried (client error, won't succeed on retry) —
      // except 408 (timeout) and 429 (rate limited), which are transient.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        return { ok: false, retryable: false };
      }
    } catch {
      // Network error or timeout — retry
    }

    // Exponential backoff: 1s, 2s
    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
  return { ok: false, retryable: true };
}

export async function deliverEvent(
  db: Db,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<EventDeliverySummary> {
  let subscriptions: DeliveryTarget[];
  try {
    const rows = await getActiveSubscriptions(db, workspaceId, eventType);
    subscriptions = rows.map((r) => ({
      url: r.url,
      secret: r.secret,
      headers: (r.headers as Record<string, string> | null) ?? null,
      filter: r.filter as { channel?: string; mentions?: string } | null,
    }));
  } catch (err) {
    // Don't swallow: a transient subscription-lookup failure must surface so the
    // caller (queue consumer) retries instead of silently dropping the event.
    throw err;
  }

  if (subscriptions.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, retryableFailures: 0 };
  }

  const eventPayload = {
    type: eventType,
    workspace_id: workspaceId,
    timestamp: new Date().toISOString(),
    data: payload,
  };

  const body = JSON.stringify(eventPayload);
  const timestamp = eventPayload.timestamp;

  const filteredSubscriptions = subscriptions.filter((sub) => matchesFilter(sub.filter, payload));

  if (filteredSubscriptions.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, retryableFailures: 0 };
  }

  const deliveryResults = await Promise.all(
    filteredSubscriptions.map(async (sub) => {
      const headers: Record<string, string> = {
        ...publicDeliveryHeaders(sub.headers),
        'Content-Type': 'application/json',
        'X-Relay-Event': eventType,
        'X-Relay-Timestamp': timestamp,
      };

      if (sub.secret) {
        headers['X-Relay-Signature'] = `sha256=${await signPayload(body, sub.secret)}`;
      }

      return attemptDelivery(sub.url, body, headers);
    }),
  );

  const attempted = deliveryResults.length;
  const succeeded = deliveryResults.filter((r) => r.ok).length;
  const failed = attempted - succeeded;
  const retryableFailures = deliveryResults.filter((r) => !r.ok && r.retryable).length;

  if (retryableFailures > 0) {
    throw codedError(`Retryable webhook delivery failures: ${retryableFailures} of ${attempted}`, 'event_delivery_retryable_failure', 503);
  }

  return { attempted, succeeded, failed, retryableFailures };
}
