import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { messageLogs } from '../../db/tables.js';

describe('console cost stats (workspace key)', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function post(token: string, text: string, cost?: Record<string, number>) {
    const res = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    if (cost) {
      await stack.runtime.deps.db
        .update(messageLogs)
        .set({ metadata: { _cost: cost } })
        .where(eq(messageLogs.messageId, body.data.id));
    }
  }

  it('aggregates per-agent cost, keeps token-only agents, drops agents with no usage, and orders by cost', async () => {
    const ws = await createWorkspace(stack.app, 'console-cost-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const dave = await registerAgent(stack.app, ws.workspaceKey, 'dave');

    await post(alice.token, 'alice one', { total_usd: 3, total_tokens: 30 });
    await post(alice.token, 'alice two', { total_usd: 1.5, prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
    await post(bob.token, 'bob one', { total_usd: 7, total_tokens: 70 });
    await post(carol.token, 'carol has no usage');
    await post(dave.token, 'dave tokens only', { prompt_tokens: 2 });

    const res = await stack.app.request('/v1/console/costs', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: {
      window_days: number;
      totals: Record<string, number>;
      agents: Array<Record<string, unknown>>;
    } };
    expect(body.data.window_days).toBe(7);
    expect(body.data.totals).toEqual({ total_cost_usd: 11.5, prompt_tokens: 6, completion_tokens: 6, total_tokens: 110 });
    expect(body.data.agents).toEqual([
      { agent_id: bob.agentId, agent_name: 'bob', message_count: 1, total_cost_usd: 7, prompt_tokens: 0, completion_tokens: 0, total_tokens: 70 },
      { agent_id: alice.agentId, agent_name: 'alice', message_count: 2, total_cost_usd: 4.5, prompt_tokens: 4, completion_tokens: 6, total_tokens: 40 },
      { agent_id: dave.agentId, agent_name: 'dave', message_count: 1, total_cost_usd: 0, prompt_tokens: 2, completion_tokens: 0, total_tokens: 0 },
    ]);
  });
});
