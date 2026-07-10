import { describe, expect, it } from 'vitest';
import { createCloudflareKv } from '../kv.js';
import type { CloudflareBindings } from '../../../env.js';

function createEnv(): CloudflareBindings {
  const values = new Map<string, string>();
  const rateLimitDo = {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(request: Request) {
          const url = new URL(request.url);
          if (url.pathname !== '/kv-increment') return new Response('Not Found', { status: 404 });

          const body = (await request.json()) as { key: string; delta: number };
          const current = /^-?\d+$/.test(values.get(body.key) ?? '') ? parseInt(values.get(body.key) ?? '0', 10) : 0;
          const next = current + body.delta;
          values.set(body.key, String(next));
          return Response.json({ ok: true, data: { value: next } });
        },
      } as DurableObjectStub;
    },
  } as DurableObjectNamespace;

  return {
    KV: {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    } as KVNamespace,
    RATE_LIMIT_DO: rateLimitDo,
  } as CloudflareBindings;
}

describe('createCloudflareKv', () => {
  it('routes increment through the Durable Object and stores the value in KV', async () => {
    const env = createEnv();
    const kv = createCloudflareKv(env);

    await expect(kv.increment('usage:ws_123:messages', 2)).resolves.toBe(2);
    await expect(kv.increment('usage:ws_123:messages', 3)).resolves.toBe(5);
    await expect(kv.get('usage:ws_123:messages')).resolves.toBe('5');
  });
});

