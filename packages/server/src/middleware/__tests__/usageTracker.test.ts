import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { createMockKV } from '../../__tests__/test-helpers.js';
import { usageTracker } from '../usageTracker.js';

function makeApp(options: { workspace?: any; kvOverride?: KVNamespace } = {}) {
  const kv = options.kvOverride ?? createMockKV();
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    (c.env as any) = { KV: kv };
    if (options.workspace) c.set('workspace', options.workspace);
    await next();
  });
  app.use('*', usageTracker);
  app.get('/test', (c) => c.json({ ok: true }));

  return { app, kv };
}

describe('usageTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('increments api_calls via KV for authenticated requests', async () => {
    const kv = createMockKV();
    const { app } = makeApp({
      workspace: { id: 'ws_123', plan: 'free' },
      kvOverride: kv,
    });

    const res = await app.request('/test');
    expect(res.status).toBe(200);

    // Fire-and-forget: give the async KV ops time to run
    await new Promise((r) => setTimeout(r, 10));

    expect(kv.get).toHaveBeenCalledWith('usage:ws_123:api_calls');
    expect(kv.put).toHaveBeenCalledWith('usage:ws_123:api_calls', '1');
  });

  it('calls next without incrementing if no workspace', async () => {
    const kv = createMockKV();
    const { app } = makeApp({ kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('still responds successfully even if KV fails', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockRejectedValue(new Error('KV down'));
    const { app } = makeApp({
      workspace: { id: 'ws_123', plan: 'free' },
      kvOverride: kv,
    });

    const res = await app.request('/test');
    // next is called immediately (KV ops are fire-and-forget)
    expect(res.status).toBe(200);
  });

  it('increments existing counter value', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('41');
    const { app } = makeApp({
      workspace: { id: 'ws_123', plan: 'free' },
      kvOverride: kv,
    });

    await app.request('/test');

    // Fire-and-forget: give the async KV ops time to run
    await new Promise((r) => setTimeout(r, 10));

    expect(kv.put).toHaveBeenCalledWith('usage:ws_123:api_calls', '42');
  });
});
