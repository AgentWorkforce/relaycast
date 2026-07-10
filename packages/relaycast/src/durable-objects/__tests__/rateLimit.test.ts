import { describe, expect, it } from 'vitest';
import { RateLimitDO } from '../rateLimit.js';

function createKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  } as KVNamespace;
}

describe('RateLimitDO', () => {
  it('serializes KV increments and persists the counter to KV', async () => {
    const kv = createKv();
    const object = new RateLimitDO({} as DurableObjectState, { KV: kv });

    const first = await object.fetch(new Request('http://do/kv-increment', {
      method: 'POST',
      body: JSON.stringify({ key: 'usage:ws_123:messages', delta: 2 }),
    }));
    const second = await object.fetch(new Request('http://do/kv-increment', {
      method: 'POST',
      body: JSON.stringify({ key: 'usage:ws_123:messages', delta: 3 }),
    }));

    await expect(first.json()).resolves.toEqual({ ok: true, data: { value: 2 } });
    await expect(second.json()).resolves.toEqual({ ok: true, data: { value: 5 } });
    await expect(kv.get('usage:ws_123:messages')).resolves.toBe('5');
  });
});

