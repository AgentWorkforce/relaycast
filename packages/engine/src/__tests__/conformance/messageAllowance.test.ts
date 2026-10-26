import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EntitlementsProvider,
  PlanLimits,
  UpgradeGuidance,
  UsageMetric,
  Workspace,
} from '../../ports/index.js';
import { lifetimeUsageCounterKey, usageCounterKey } from '../../engine/usage.js';
import { PLAN_LIMITS } from '../../providers/static-entitlements.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

const SIGN_IN_URL = 'https://example.test/login';

/** Entitlements that resolve fixed limits and, optionally, upgrade guidance. */
class FixedEntitlements implements EntitlementsProvider {
  constructor(
    private readonly stackRef: () => TestStack,
    private readonly limits: PlanLimits,
    private readonly guidance: UpgradeGuidance | null = null,
  ) {}

  async getLimits(_workspace: Workspace): Promise<PlanLimits> {
    return this.limits;
  }

  async getUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
    const raw = await this.stackRef().runtime.deps.kv.get(usageCounterKey(workspaceId, metric));
    return Number.parseInt(raw || '0', 10) || 0;
  }

  async getUpgradeGuidance(): Promise<UpgradeGuidance | null> {
    return this.guidance;
  }
}

const UNLIMITED: PlanLimits = {
  messages: Infinity,
  agents: Infinity,
  file_bytes: Infinity,
  api_calls: Infinity,
  rate_per_min: 30_000,
};

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

async function lifetimeMessages(stack: TestStack, workspaceId: string): Promise<string | null> {
  await stack.settle();
  return stack.runtime.deps.kv.get(lifetimeUsageCounterKey(workspaceId, 'messages'));
}

describe('lifetime message allowance', () => {
  let stack: TestStack | undefined;

  afterEach(async () => {
    await stack?.close();
  });

  it('counts channel posts, DMs and thread replies, then refuses with a sign-in URL', async () => {
    stack = makeNodeStack({
      entitlements: new FixedEntitlements(
        () => stack as TestStack,
        { ...UNLIMITED, lifetime_messages: 3 },
        { url: SIGN_IN_URL, action: 'sign_in', plan: 'trial', hint: 'Sign in for free to keep going:' },
      ),
    });
    const { ws, alice } = await seedConversation(stack, 'trial-ws');

    const post = await stack.app.request('/v1/channels/team/messages', json(alice.token, { text: 'one' }));
    expect(post.status).toBe(201);
    const posted = (await post.json()) as { data: { id: string } };

    const dm = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'two' }));
    expect(dm.status).toBe(201);

    const reply = await stack.app.request(`/v1/messages/${posted.data.id}/replies`, json(alice.token, { text: 'three' }));
    expect(reply.status).toBe(201);
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBe('3');

    const refused = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'four' }));
    expect(refused.status).toBe(429);
    // The allowance never resets, so no retry contract is advertised.
    expect(refused.headers.get('Retry-After')).toBeNull();
    const body = (await refused.json()) as { ok: boolean; error: Record<string, unknown> };
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: 'plan_limit_exceeded',
        metric: 'messages',
        plan: 'trial',
        limit: 3,
        usage: 3,
        upgrade_url: SIGN_IN_URL,
        upgrade_action: 'sign_in',
      },
    });
    expect(body.error.message).toContain('3 of its 3 messages');
    expect(body.error.message).toContain(`Sign in for free to keep going: ${SIGN_IN_URL}`);
    // A refused send is not counted.
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBe('3');

    // Reads keep working after the allowance is spent.
    const inbox = await stack.app.request('/v1/inbox', { headers: { authorization: `Bearer ${alice.token}` } });
    expect(inbox.status).toBe(200);
  });

  it('does not spend the allowance on a send that fails', async () => {
    stack = makeNodeStack({
      entitlements: new FixedEntitlements(() => stack as TestStack, { ...UNLIMITED, lifetime_messages: 1 }),
    });
    const { ws, alice } = await seedConversation(stack, 'failed-send-ws');

    const missing = await stack.app.request('/v1/dm', json(alice.token, { to: 'nobody', text: 'hi' }));
    expect(missing.status).toBeGreaterThanOrEqual(400);
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBeNull();

    const ok = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: 'hi' }));
    expect(ok.status).toBe(201);

    const refused = await stack.app.request('/v1/channels/team/messages', json(alice.token, { text: 'again' }));
    expect(refused.status).toBe(429);
    // No host guidance: the error still names the limit and carries a null URL.
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: 'plan_limit_exceeded', upgrade_url: null, upgrade_action: null },
    });
  });

  it('never counts or caps a plan without a lifetime allowance', async () => {
    stack = makeNodeStack({
      entitlements: new FixedEntitlements(() => stack as TestStack, PLAN_LIMITS.free!),
    });
    const { ws, alice } = await seedConversation(stack, 'free-ws');
    for (let i = 0; i < 3; i += 1) {
      const res = await stack.app.request('/v1/dm', json(alice.token, { to: 'bob', text: `m${i}` }));
      expect(res.status).toBe(201);
    }
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBeNull();
  });

  it('leaves the self-host default unlimited and uncounted', async () => {
    stack = makeNodeStack();
    const { ws, alice } = await seedConversation(stack, 'selfhost-ws');
    const res = await stack.app.request('/v1/channels/team/messages', json(alice.token, { text: 'hi' }));
    expect(res.status).toBe(201);
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBeNull();
  });

  it('puts the host upgrade URL on a period quota error', async () => {
    stack = makeNodeStack({
      entitlements: new FixedEntitlements(
        () => stack as TestStack,
        { ...UNLIMITED, api_calls: 1 },
        { url: 'https://example.test/billing', action: 'upgrade' },
      ),
    });
    const ws = await createWorkspace(stack.app, 'billing-ws');
    const identity = () => (stack as TestStack).app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect((await identity()).status).toBe(200);
    const blocked = await identity();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).not.toBeNull();
    const body = (await blocked.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: 'plan_limit_exceeded',
      metric: 'api_calls',
      upgrade_url: 'https://example.test/billing',
      upgrade_action: 'upgrade',
    });
    expect(body.error.message).toContain('Upgrade your plan to increase limits: https://example.test/billing');
  });

  it('never spends the allowance on an idempotent replay, and still replays after it is spent', async () => {
    stack = makeNodeStack({
      entitlements: new FixedEntitlements(
        () => stack as TestStack,
        { ...UNLIMITED, lifetime_messages: 2 },
        { url: SIGN_IN_URL, action: 'sign_in', plan: 'trial' },
      ),
    });
    const { ws, alice } = await seedConversation(stack, 'replay-ws');
    const send = (key: string, text: string, path = '/v1/dm', body: unknown = { to: 'bob', text }) =>
      (stack as TestStack).app.request(path, json(alice.token, body, key));

    const first = await send('key-one', 'one');
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const retry = await send('key-one', 'one');
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotency-Replayed')).toBe('true');
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBe('1');

    const second = await send('key-two', 'two', '/v1/channels/team/messages', { text: 'two' });
    expect(second.status).toBe(201);
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBe('2');

    // Spent: a replay of an earlier successful send still returns its receipt.
    const lateRetry = await send('key-one', 'one');
    expect(lateRetry.status).toBe(201);
    expect(lateRetry.headers.get('Idempotency-Replayed')).toBe('true');
    await expect(lateRetry.json()).resolves.toEqual(firstBody);

    // A fresh keyed send is refused by the route with the full body.
    const fresh = await send('key-three', 'three');
    expect(fresh.status).toBe(429);
    expect(fresh.headers.get('Retry-After')).toBeNull();
    await expect(fresh.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'plan_limit_exceeded', metric: 'messages', plan: 'trial', limit: 2, usage: 2, upgrade_url: SIGN_IN_URL, upgrade_action: 'sign_in' },
    });
    // ...and does not leave an idempotency lock behind that would 409 a retry.
    const freshAgain = await send('key-three', 'three');
    expect(freshAgain.status).toBe(429);
    for (const [path, body] of [
      ['/v1/channels/team/messages', { text: 'x' }],
      [`/v1/messages/${(firstBody as { data: { id: string } }).data.id}/replies`, { text: 'x' }],
    ] as const) {
      expect((await send(`key-${path}`, 'x', path, body)).status).toBe(429);
    }
    await expect(lifetimeMessages(stack, ws.workspaceId)).resolves.toBe('2');
  });

  it('keeps the count alive past the response through waitUntil', async () => {
    stack = makeNodeStack({
      entitlements: new FixedEntitlements(() => stack as TestStack, { ...UNLIMITED, lifetime_messages: 5 }),
    });
    const { ws, alice } = await seedConversation(stack, 'wait-until-ws');
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
    await expect(stack.runtime.deps.kv.get(lifetimeUsageCounterKey(ws.workspaceId, 'messages'))).resolves.toBe('1');
  });
});
