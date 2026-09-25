import { afterEach, describe, expect, it } from 'vitest';
import type { EntitlementsProvider, PlanLimits, Workspace } from '../../ports/index.js';
import { InProcessRateLimiter } from '../../adapters/node/rate-limit.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

function entitlementsWithRate(ratePerMin: number): EntitlementsProvider {
  return {
    async getLimits(_workspace: Workspace): Promise<PlanLimits> {
      return {
        messages: Infinity,
        agents: Infinity,
        file_bytes: Infinity,
        api_calls: Infinity,
        rate_per_min: ratePerMin,
      };
    },
    async getUsage() { return 0; },
  };
}

describe('rate limit contract', () => {
  let stack: TestStack | undefined;

  afterEach(() => stack?.close());

  const get = (path: string, key: string) =>
    (stack as TestStack).app.request(path, { headers: { authorization: `Bearer ${key}` } });

  // Regression: workspace identity shared the workspace-wide `global` bucket, so
  // ordinary data-plane traffic starved the one read a client makes to validate
  // its credentials and start a run. Retrying could never help — every attempt
  // landed in the same saturated bucket.
  it('keeps workspace identity readable when the shared bucket is exhausted', async () => {
    stack = makeNodeStack({ entitlements: entitlementsWithRate(2) });
    const ws = await createWorkspace(stack.app, 'identity-bucket-ws');

    expect((await get('/v1/agents', ws.workspaceKey)).status).toBe(200);
    expect((await get('/v1/agents', ws.workspaceKey)).status).toBe(200);

    const throttled = await get('/v1/agents', ws.workspaceKey);
    expect(throttled.status).toBe(429);
    await expect(throttled.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'rate_limit_exceeded' },
    });

    const identity = await get('/v1/workspace', ws.workspaceKey);
    expect(identity.status).toBe(200);
  });

  it('puts a bounded retry contract on a throttled response', async () => {
    stack = makeNodeStack({ entitlements: entitlementsWithRate(1) });
    const ws = await createWorkspace(stack.app, 'retry-contract-ws');

    expect((await get('/v1/agents', ws.workspaceKey)).status).toBe(200);

    const throttled = await get('/v1/agents', ws.workspaceKey);
    expect(throttled.status).toBe(429);

    // A per-minute bucket always clears inside the window, so the advertised
    // wait is short and real — a caller can retry rather than guess a backoff.
    const retryAfter = Number(throttled.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const resetAt = Number(throttled.headers.get('X-RateLimit-Reset')) * 1000;
    expect(resetAt).toBeGreaterThan(Date.now());
    expect(resetAt - Date.now()).toBeLessThanOrEqual(60_000);

    expect(throttled.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(throttled.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('charges an addressed DM to the same bucket as POST /v1/dm', async () => {
    stack = makeNodeStack({ entitlements: entitlementsWithRate(10) });
    const ws = await createWorkspace(stack.app, 'addressed-dm-bucket-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const post = (path: string, body: unknown) => (stack as TestStack).app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify(body),
    });

    const dm = await post('/v1/dm', { to: 'bob', text: 'one' });
    expect(dm.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(dm.headers.get('X-RateLimit-Remaining')).toBe('4');
    const addressed = await post('/v1/to/bob%40direct', { text: 'two' });
    expect(addressed.status).toBe(201);
    expect(addressed.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(addressed.headers.get('X-RateLimit-Remaining')).toBe('3');
  });

  it('reports the window reset on a successful response', async () => {
    stack = makeNodeStack({ entitlements: entitlementsWithRate(10) });
    const ws = await createWorkspace(stack.app, 'reset-header-ws');

    const res = await get('/v1/workspace', ws.workspaceKey);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(Number(res.headers.get('X-RateLimit-Reset')) * 1000).toBeGreaterThan(Date.now());
  });

  it('rejects public workspace lookups with a retry contract', async () => {
    stack = makeNodeStack();
    await createWorkspace(stack.app, 'public-lookup-ws');

    let throttled: Response | undefined;
    for (let i = 0; i < 40; i += 1) {
      const res = await (stack as TestStack).app.request('/v1/workspaces/by-name/public-lookup-ws');
      if (res.status === 429) { throttled = res; break; }
    }

    expect(throttled).toBeDefined();
    expect(Number(throttled?.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(throttled?.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});

describe('in-process rate limiter', () => {
  // A throttled caller's own retries used to keep incrementing the bucket, so
  // `count` ran away past the limit and any sliding-window backend would let a
  // retry loop hold its own window open.
  it('does not let a rejected request consume the bucket', async () => {
    const limiter = new InProcessRateLimiter();
    const args = { bucketKey: 'retry-amplification', limit: 2, windowMs: 60_000 };

    await limiter.check(args);
    await limiter.check(args);

    const first = await limiter.check(args);
    const afterRetries = await limiter.check(args);

    expect(first.allowed).toBe(false);
    expect(afterRetries.allowed).toBe(false);
    expect(afterRetries.count).toBe(2);
    expect(afterRetries.remaining).toBe(0);
  });
});
