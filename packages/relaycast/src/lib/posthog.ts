import { PostHog } from 'posthog-node';
import type { CloudflareBindings } from '../env.js';

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function telemetryEnabled(env: CloudflareBindings): boolean {
  return !isTruthy(env.DO_NOT_TRACK) && !isTruthy(env.RELAYCAST_TELEMETRY_DISABLED);
}

function getPostHogHost(env: CloudflareBindings): string {
  const configured = env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  return configured.endsWith('/') ? configured.slice(0, -1) : configured;
}

type ClientState = {
  client: PostHog;
};

type PostHogClientWithShutdown = PostHog & {
  shutdown?: (shutdownTimeoutMs?: number) => void | Promise<void>;
  _shutdown?: (shutdownTimeoutMs?: number) => Promise<void>;
};

const clients = new Map<string, ClientState>();

export function getPostHogClient(env: CloudflareBindings, apiKey: string): PostHog {
  const key = `${getPostHogHost(env)}|${apiKey}`;
  const existing = clients.get(key);
  if (existing) return existing.client;

  const client = new PostHog(apiKey, {
    host: getPostHogHost(env),
    flushAt: 20,
    flushInterval: 250,
  });

  clients.set(key, { client });
  return client;
}

export { telemetryEnabled };

/**
 * Non-destructive flush of every live PostHog client's buffer.
 *
 * Required on Cloudflare Workers: the posthog-node client batches with
 * `flushAt`/`flushInterval`, but once a Worker returns its Response the isolate
 * is suspended — the `flushInterval` timer never fires and low-volume traffic
 * never reaches `flushAt`, so buffered events are dropped when the isolate is
 * evicted. Call this from `ctx.waitUntil(...)` after each request/queue/cron so
 * the in-memory buffer is POSTed before the isolate goes idle. Unlike
 * {@link flushAllPostHogClients} this keeps the clients alive for reuse across
 * requests in the same isolate.
 *
 * Best-effort: telemetry must never throw into the request path, so per-client
 * flush failures are swallowed.
 */
export async function flushPostHogClients(): Promise<void> {
  await Promise.all(
    [...clients.values()].map(({ client }) =>
      client.flush().catch(() => {
        // best-effort delivery; never surface telemetry errors to callers
      }),
    ),
  );
}

export async function flushAllPostHogClients(): Promise<void> {
  try {
    await Promise.all(
      [...clients.values()].map(({ client }) => {
        const posthog = client as PostHogClientWithShutdown;
        if (typeof posthog.shutdown === 'function') return posthog.shutdown();
        return posthog._shutdown?.();
      }),
    );
  } finally {
    clients.clear();
  }
}
