import { afterEach, describe, expect, it, vi } from 'vitest';

type MockClient = {
  capture: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
};

vi.mock('posthog-node', () => {
  class PostHog {
    capture = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
  }
  return { PostHog };
});

const env = { POSTHOG_HOST: 'https://us.i.posthog.com' } as never;

describe('flushPostHogClients', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('flushes each live client without shutting it down, and keeps it reusable', async () => {
    const { getPostHogClient, flushPostHogClients } = await import('../posthog.js');

    // Distinct key per test so the module-level client map gives us a fresh client.
    const client = getPostHogClient(env, 'phc_flush_a') as unknown as MockClient;

    await flushPostHogClients();

    expect(client.flush).toHaveBeenCalledTimes(1);
    expect(client.shutdown).not.toHaveBeenCalled();

    // Non-destructive: the same isolate's next request reuses the client rather
    // than constructing (and re-handshaking) a new one.
    const reused = getPostHogClient(env, 'phc_flush_a');
    expect(reused).toBe(client as unknown as object);
  });

  it('swallows per-client flush failures (telemetry never throws into callers)', async () => {
    const { getPostHogClient, flushPostHogClients } = await import('../posthog.js');

    const client = getPostHogClient(env, 'phc_flush_err') as unknown as MockClient;
    client.flush.mockRejectedValueOnce(new Error('network down'));

    await expect(flushPostHogClients()).resolves.toBeUndefined();
  });
});
