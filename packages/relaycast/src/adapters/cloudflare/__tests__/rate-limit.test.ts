import { describe, expect, it } from 'vitest';
import { createCloudflareRateLimiter } from '../rate-limit.js';
import type { CloudflareBindings } from '../../../env.js';

function createEnv() {
  const shardNames: string[] = [];
  const env = {
    RATE_LIMIT_DO: {
      idFromName(name: string) {
        shardNames.push(name);
        return name;
      },
      get() {
        return {
          async fetch(request: Request) {
            const body = await request.json() as { limit: number };
            return Response.json({
              ok: true,
              data: {
                count: 1,
                remaining: Math.max(0, body.limit - 1),
                allowed: true,
              },
            });
          },
        };
      },
    },
  } as unknown as CloudflareBindings;

  return { env, shardNames };
}

describe('createCloudflareRateLimiter', () => {
  it('only strips numeric window suffixes when choosing a DO shard', async () => {
    const { env, shardNames } = createEnv();
    const limiter = createCloudflareRateLimiter(env);

    await limiter.check({ bucketKey: 'ws_1:delivery:GET', limit: 10, windowMs: 60_000 });
    await limiter.check({ bucketKey: 'ws_1:global:12345', limit: 10, windowMs: 60_000 });

    expect(shardNames).toEqual(['ws_1:delivery:GET', 'ws_1:global']);
  });
});
