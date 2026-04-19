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

export async function flushAllPostHogClients(): Promise<void> {
  try {
    await Promise.all([...clients.values()].map(({ client }) => client.shutdown()));
  } finally {
    clients.clear();
  }
}
