import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdmissionContext, AdmissionDenial, AdmissionHooks } from '../../ports/index.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * A host that allows `messageLimit` committed sends per workspace and refuses
 * the rest, recording every hook call.
 */
class MessageLimitHooks implements AdmissionHooks {
  readonly committedCalls: AdmissionContext[] = [];
  private readonly sent = new Map<string, number>();

  constructor(private readonly messageLimit: number, private readonly denial: Partial<AdmissionDenial> = {}) {}

  async admit({ workspace, action }: AdmissionContext): Promise<AdmissionDenial | null> {
    if (action !== 'message') return null;
    const used = this.sent.get(workspace.id) ?? 0;
    if (used < this.messageLimit) return null;
    return {
      status: 429,
      code: 'message_quota_exceeded',
      message: `Sent ${used} of ${this.messageLimit} messages.`,
      details: { limit: this.messageLimit, usage: used },
      ...this.denial,
    };
  }

  async committed(ctx: AdmissionContext): Promise<void> {
    this.committedCalls.push(ctx);
    if (ctx.action === 'message') this.sent.set(ctx.workspace.id, (this.sent.get(ctx.workspace.id) ?? 0) + 1);
  }

  messagesCommitted(): number {
    return this.committedCalls.filter((call) => call.action === 'message').length;
  }
}

function json(token: string, body: unknown, idempotencyKey?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function seedConversation(stack: TestStack, name: string) {
  const ws = await createWorkspace(stack.app, name);
  const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
  const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
  const channel = await stack.app.request('/v1/channels', json(ws.workspaceKey, { name: 'team' }));
  expect(channel.status).toBe(201);
  for (const token of [alice.token, bob.token]) {
    const join = await stack.app.request('/v1/channels/team/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(join.status).toBe(200);
  }
  return { ws, alice, bob };
}

describe('admission hooks', () => {
  let stack: TestStack | undefined;

  afterEach(async () => {
    await stack?.close();
  });

  it('admits everything without hooks, under the default rate ceiling', async () => {
    stack = makeNodeStack();
    const { ws, alice } = await seedConversation(stack, 'selfhost-ws');
    for (let i = 0; i < 3; i += 1) {
      const res = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: `m${i}` }));
      expect(res.status).toBe(201);
    }
    const identity = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(identity.status).toBe(200);
    expect(identity.headers.get('X-RateLimit-Limit')).toBe('30000');
    const body = (await identity.json()) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty('plan');
  });

  it('commits channel posts, DMs and thread replies, then renders the host denial', async () => {
    const hooks = new MessageLimitHooks(3);
    stack = makeNodeStack({ admission: hooks });
    const { alice } = await seedConversation(stack, 'limited-ws');

    const post = await stack.app.request('/v1/channels/team/messages', json(alice.token, { text: 'one' }));
    expect(post.status).toBe(201);
    const posted = (await post.json()) as { data: { id: string } };
    expect((await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'two' }))).status).toBe(201);
    expect((await stack.app.request(`/v1/messages/${posted.data.id}/replies`, json(alice.token, { text: 'three' }))).status).toBe(201);
    await stack.settle();
    expect(hooks.messagesCommitted()).toBe(3);

    const refused = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'four' }));
    expect(refused.status).toBe(429);
    // No `retryAt`: neither the retry contract nor the per-minute reset is advertised.
    expect(refused.headers.get('Retry-After')).toBeNull();
    expect(refused.headers.get('X-RateLimit-Reset')).toBeNull();
    await expect(refused.json()).resolves.toEqual({
      ok: false,
      error: { code: 'message_quota_exceeded', message: 'Sent 3 of 3 messages.', limit: 3, usage: 3 },
    });
    await stack.settle();
    expect(hooks.messagesCommitted()).toBe(3);

    // Reads are not message sends.
    const inbox = await stack.app.request('/v1/inbox', { headers: { authorization: `Bearer ${alice.token}` } });
    expect(inbox.status).toBe(200);
  });

  it('does not commit a send that fails', async () => {
    const hooks = new MessageLimitHooks(1);
    stack = makeNodeStack({ admission: hooks });
    const { alice } = await seedConversation(stack, 'failed-send-ws');

    const missing = await stack.app.request('/v1/dm', json(alice.token, { to: 'nobody', text: 'hi' }));
    expect(missing.status).toBeGreaterThanOrEqual(400);
    await stack.settle();
    expect(hooks.messagesCommitted()).toBe(0);

    expect((await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'hi' }))).status).toBe(201);
    const refused = await stack.app.request('/v1/channels/team/messages', json(alice.token, { text: 'again' }));
    expect(refused.status).toBe(429);
  });

  it('never commits an idempotent replay, and still replays after a denial', async () => {
    const hooks = new MessageLimitHooks(2);
    stack = makeNodeStack({ admission: hooks });
    const { alice } = await seedConversation(stack, 'replay-ws');
    const send = (key: string, text: string, path = '/v1/dm', body: unknown = { to: 'bob', text }) =>
      (stack as TestStack).app.request(path, json(alice.token, body, key));

    const first = await send('key-one', 'one');
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const retry = await send('key-one', 'one');
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    await stack.settle();
    expect(hooks.messagesCommitted()).toBe(1);

    expect((await send('key-two', 'two', '/v1/channels/team/messages', { text: 'two' })).status).toBe(201);
    await stack.settle();
    expect(hooks.messagesCommitted()).toBe(2);

    // Denied: a replay of an earlier successful send still returns its receipt.
    const lateRetry = await send('key-one', 'one');
    expect(lateRetry.status).toBe(201);
    expect(lateRetry.headers.get('Idempotency-Replayed')).toBe('true');
    await expect(lateRetry.json()).resolves.toEqual(firstBody);

    // A fresh keyed send is refused by the route with the host's denial.
    const fresh = await send('key-three', 'three');
    expect(fresh.status).toBe(429);
    expect(fresh.headers.get('Retry-After')).toBeNull();
    expect(fresh.headers.get('X-RateLimit-Reset')).toBeNull();
    await expect(fresh.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'message_quota_exceeded', limit: 2, usage: 2 },
    });
    // ...and leaves no idempotency lock behind that would 409 a retry.
    expect((await send('key-three', 'three')).status).toBe(429);
    for (const [path, body] of [
      ['/v1/channels/team/messages', { text: 'x' }],
      [`/v1/messages/${(firstBody as { data: { id: string } }).data.id}/replies`, { text: 'x' }],
    ] as const) {
      expect((await send(`key-${path}`, 'x', path, body)).status).toBe(429);
    }
    await stack.settle();
    expect(hooks.messagesCommitted()).toBe(2);
  });

  it('admits and commits group-DM messages', async () => {
    const hooks = new MessageLimitHooks(1);
    stack = makeNodeStack({ admission: hooks });
    const { alice } = await seedConversation(stack, 'group-dm-ws');
    const group = await stack.app.request('/v1/dm/group', json(alice.token, { participants: ['bob'] }));
    expect(group.status).toBe(201);
    const { data } = (await group.json()) as { data: { id: string } };

    expect((await stack.app.request(`/v1/dm/${data.id}/messages`, json(alice.token, { text: 'one' }))).status).toBe(201);
    await stack.settle();
    const refused = await stack.app.request(`/v1/dm/${data.id}/messages`, json(alice.token, { text: 'two' }, 'group-key'));
    expect(refused.status).toBe(429);
  });

  it('keeps the commit alive past the response through waitUntil', async () => {
    const hooks = new MessageLimitHooks(5);
    stack = makeNodeStack({ admission: hooks });
    const { alice } = await seedConversation(stack, 'wait-until-ws');
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => { pending.push(promise); }),
      passThroughOnException: () => {},
      props: {},
    };
    const res = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'hi' }), undefined, executionCtx);
    expect(res.status).toBe(201);
    expect(executionCtx.waitUntil).toHaveBeenCalled();
    await Promise.all(pending);
    expect(hooks.messagesCommitted()).toBe(1);
  });

  it('refuses a request with the host denial and its retry contract', async () => {
    const retryAt = Date.now() + 90_000;
    let requests = 0;
    stack = makeNodeStack({
      admission: {
        async admit({ action }) {
          if (action !== 'request') return null;
          requests += 1;
          return requests > 1
            ? { status: 429, code: 'request_quota_exceeded', message: 'Quota spent.', details: { upgrade_url: 'https://example.test/billing' }, retryAt }
            : null;
        },
      },
    });
    const ws = await createWorkspace(stack.app, 'request-quota-ws');
    const identity = () => (stack as TestStack).app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect((await identity()).status).toBe(200);
    const blocked = await identity();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(blocked.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(retryAt / 1000)));
    await expect(blocked.json()).resolves.toEqual({
      ok: false,
      error: { code: 'request_quota_exceeded', message: 'Quota spent.', upgrade_url: 'https://example.test/billing' },
    });
  });

  it('commits successful requests only', async () => {
    const committed: string[] = [];
    stack = makeNodeStack({
      admission: { async committed({ action }) { committed.push(action); } },
    });
    const ws = await createWorkspace(stack.app, 'request-commit-ws');
    const ok = await stack.app.request('/v1/workspace', { headers: { authorization: `Bearer ${ws.workspaceKey}` } });
    expect(ok.status).toBe(200);
    const missing = await stack.app.request('/v1/agents/nobody', { headers: { authorization: `Bearer ${ws.workspaceKey}` } });
    expect(missing.status).toBe(404);
    await stack.settle();
    expect(committed).toEqual(['request']);
  });

  it('admits when a hook throws', async () => {
    stack = makeNodeStack({
      admission: {
        async admit() { throw new Error('metering down'); },
        async rateLimitPerMinute() { throw new Error('metering down'); },
      },
      rateLimitPerMinute: 120,
    });
    const { alice } = await seedConversation(stack, 'hook-outage-ws');
    const res = await stack.app.request('/v1/channels/team/messages', json(alice.token, { text: 'hi' }));
    expect(res.status).toBe(201);
    // The configured ceiling holds through a failing rate hook (message sends get half).
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
  });

  it('ignores an invalid configured ceiling', async () => {
    for (const rateLimitPerMinute of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY]) {
      stack = makeNodeStack({ rateLimitPerMinute });
      const ws = await createWorkspace(stack.app, 'bad-config-ws');
      const res = await stack.app.request('/v1/workspace', { headers: { authorization: `Bearer ${ws.workspaceKey}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBe('30000');
      await stack.close();
      stack = undefined;
    }
  });

  it('takes the per-workspace rate ceiling from the hook', async () => {
    stack = makeNodeStack({
      admission: { async rateLimitPerMinute() { return 1; } },
      rateLimitPerMinute: 1000,
    });
    const ws = await createWorkspace(stack.app, 'rate-hook-ws');
    const identity = () => (stack as TestStack).app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const first = await identity();
    expect(first.status).toBe(200);
    expect(first.headers.get('X-RateLimit-Limit')).toBe('1');
    const second = await identity();
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded. 1 requests per minute allowed.' },
    });
  });
});
