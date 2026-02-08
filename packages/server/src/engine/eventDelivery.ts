import { createHmac } from 'node:crypto';
import { getActiveSubscriptions } from './eventSubscription.js';

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

interface DeliveryTarget {
  url: string;
  secret: string | null;
  filter: { channel?: string; mentions?: string } | null;
}

function matchesFilter(
  filter: { channel?: string; mentions?: string } | null,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;

  if (filter.channel) {
    const channelName = (payload.channel_name as string) || (payload.channel as string) || '';
    if (channelName && channelName !== filter.channel) return false;
  }

  if (filter.mentions) {
    const text = (payload.text as string) || '';
    if (!text.includes(`@${filter.mentions}`)) return false;
  }

  return true;
}

async function attemptDelivery(
  url: string,
  body: string,
  headers: Record<string, string>,
  retries: number = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || (response.status >= 200 && response.status < 300)) {
        return true;
      }
      // 4xx errors are not retried (client error, won't succeed on retry)
      if (response.status >= 400 && response.status < 500) {
        return false;
      }
    } catch {
      // Network error or timeout — retry
    }

    // Exponential backoff: 1s, 2s, 4s
    if (attempt < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
  return false;
}

export async function deliverEvent(
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  let subscriptions: DeliveryTarget[];
  try {
    const rows = await getActiveSubscriptions(workspaceId, eventType);
    subscriptions = rows.map((r) => ({
      url: r.url,
      secret: r.secret,
      filter: r.filter as { channel?: string; mentions?: string } | null,
    }));
  } catch {
    return;
  }

  if (subscriptions.length === 0) return;

  const eventPayload = {
    type: eventType,
    workspace_id: workspaceId,
    timestamp: new Date().toISOString(),
    data: payload,
  };

  const body = JSON.stringify(eventPayload);
  const timestamp = eventPayload.timestamp;

  const deliveries = subscriptions
    .filter((sub) => matchesFilter(sub.filter, payload))
    .map((sub) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Relay-Event': eventType,
        'X-Relay-Timestamp': timestamp,
      };

      if (sub.secret) {
        headers['X-Relay-Signature'] = `sha256=${signPayload(body, sub.secret)}`;
      }

      return attemptDelivery(sub.url, body, headers).catch(() => {});
    });

  // Fire-and-forget — don't await (but return the promise for testing)
  Promise.allSettled(deliveries).catch(() => {});
}
