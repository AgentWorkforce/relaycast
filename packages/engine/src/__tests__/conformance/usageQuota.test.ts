import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementsProvider, PlanLimits, UsageMetric, Workspace } from '../../ports/index.js';
import { usageCounterKey, usagePeriodResetAt } from '../../engine/usage.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

class ApiCallQuotaEntitlements implements EntitlementsProvider {
  constructor(
    private readonly stackRef: () => TestStack,
    private readonly apiCallLimit: number,
  ) {}

  async getLimits(_workspace: Workspace): Promise<PlanLimits> {
    return {
      messages: Infinity,
      agents: Infinity,
      file_bytes: Infinity,
      api_calls: this.apiCallLimit,
      rate_per_min: 300,
    };
  }

  // Reads the same period-scoped counter the usage tracker writes, so the
  // reader and writer agree on which billing period is being measured.
  async getUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
    const raw = await this.stackRef().runtime.deps.kv.get(usageCounterKey(workspaceId, metric));
    return Number.parseInt(raw || '0', 10) || 0;
  }

  async getUsageResetAt(): Promise<number> {
    return usagePeriodResetAt();
  }
}

describe('usage quotas', () => {
  let stack: TestStack | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await stack?.close();
  });

  it('records authenticated API calls and enforces the api_calls plan limit', async () => {
    stack = makeNodeStack({
      entitlements: new ApiCallQuotaEntitlements(() => stack, 2),
    });
    const ws = await createWorkspace(stack.app, 'api-call-quota-ws');

    const register = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'quota-agent' }),
    });
    expect(register.status).toBe(201);
    const counter = usageCounterKey(ws.workspaceId, 'api_calls');
    await expect(stack.runtime.deps.kv.get(counter)).resolves.toBe('1');

    const allowed = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(allowed.status).toBe(200);
    await expect(stack.runtime.deps.kv.get(counter)).resolves.toBe('2');

    const blocked = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'plan_limit_exceeded' },
    });
    await expect(stack.runtime.deps.kv.get(counter)).resolves.toBe('2');
  });

  // Regression: the api_calls counter was unscoped, so it accumulated for the
  // lifetime of the workspace. Once it passed the plan ceiling every
  // authenticated request 429'd permanently — including the GET /v1/workspace
  // identity read a launch needs — with no window that ever cleared it.
  it('clears an exhausted api_calls quota when the usage period rolls over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T23:59:00.000Z'));

    stack = makeNodeStack({
      entitlements: new ApiCallQuotaEntitlements(() => stack as TestStack, 1),
    });
    const ws = await createWorkspace(stack.app, 'quota-rollover-ws');
    const identity = () => (stack as TestStack).app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });

    expect((await identity()).status).toBe(200);

    const exhausted = await identity();
    expect(exhausted.status).toBe(429);
    await expect(exhausted.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'plan_limit_exceeded' },
    });
    // The 429 advertises when it actually clears: the start of the next period.
    expect(exhausted.headers.get('X-RateLimit-Reset'))
      .toBe(String(Date.UTC(2026, 3, 1) / 1000));
    expect(Number(exhausted.headers.get('Retry-After'))).toBe(60);

    vi.setSystemTime(new Date('2026-04-01T00:00:01.000Z'));

    const afterRollover = await identity();
    expect(afterRollover.status).toBe(200);
    await expect(stack.runtime.deps.kv.get(usageCounterKey(ws.workspaceId, 'api_calls')))
      .resolves.toBe('1');
  });

  it('keeps each usage period counted separately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));

    stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'quota-period-ws');
    const identity = () => (stack as TestStack).app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });

    await identity();
    const march = usageCounterKey(ws.workspaceId, 'api_calls', new Date('2026-03-15T12:00:00.000Z'));
    await expect(stack.runtime.deps.kv.get(march)).resolves.toBe('1');

    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    await identity();

    const april = usageCounterKey(ws.workspaceId, 'api_calls', new Date('2026-04-15T12:00:00.000Z'));
    expect(april).not.toBe(march);
    await expect(stack.runtime.deps.kv.get(april)).resolves.toBe('1');
  });

  it('refreshes agent presence on authenticated API calls', async () => {
    stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'presence-refresh-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'present-agent');

    await expect(stack.runtime.presence.getOnline(ws.workspaceId)).resolves.toEqual([]);

    const inbox = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(inbox.status).toBe(200);
    await expect(stack.runtime.presence.getOnline(ws.workspaceId)).resolves.toContain(agent.agentId);
  });
});
