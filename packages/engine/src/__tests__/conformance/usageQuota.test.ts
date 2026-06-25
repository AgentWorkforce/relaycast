import { afterEach, describe, expect, it } from 'vitest';
import type { EntitlementsProvider, PlanLimits, UsageMetric, Workspace } from '../../ports/index.js';
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

  async getUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
    const raw = await this.stackRef().runtime.deps.kv.get(`usage:${workspaceId}:${metric}`);
    return Number.parseInt(raw || '0', 10) || 0;
  }
}

describe('usage quotas', () => {
  let stack: TestStack | undefined;

  afterEach(() => stack?.close());

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
    await expect(stack.runtime.deps.kv.get(`usage:${ws.workspaceId}:api_calls`)).resolves.toBe('1');

    const allowed = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(allowed.status).toBe(200);
    await expect(stack.runtime.deps.kv.get(`usage:${ws.workspaceId}:api_calls`)).resolves.toBe('2');

    const blocked = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'plan_limit_exceeded' },
    });
    await expect(stack.runtime.deps.kv.get(`usage:${ws.workspaceId}:api_calls`)).resolves.toBe('2');
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
