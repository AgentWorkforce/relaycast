import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

describe('agent subscription channels', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });
  it('provisions an idempotent exact recipient route and rejects membership widening', async () => {
    const ws = await createWorkspace(stack.app, 'targeting');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'target-hyphen');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'target');
    const post = (path: string, token: string, body?: unknown) => stack.app.request(path, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const endpoint = '/v1/agents/target-hyphen/subscription-channel';
    expect((await post(endpoint, other.token)).status).toBe(401);
    const response = await post(endpoint, ws.workspaceKey);
    expect(response.status).toBe(200);
    const { data: route } = await response.json() as { data: { name: string; members: Array<{ agent_name: string }> } };
    expect(route.members.map(m => m.agent_name)).toEqual(['target-hyphen']);
    expect((await (await post(endpoint, ws.workspaceKey)).json()).data.name).toBe(route.name);
    expect((await post(`/v1/channels/${route.name}/join`, other.token)).status).toBe(403);
    expect((await post(`/v1/channels/${route.name}/invite`, target.token, { agent_name: 'target' })).status).toBe(403);
    const hook = await post('/v1/webhooks', ws.workspaceKey, { channel: route.name });
    expect(hook.status).toBe(201);
    const { data: webhook } = await hook.json();
    const sent = await post(`/v1/hooks/${webhook.webhook_id}`, webhook.token, { text: 'event-only-fixture' });
    expect(sent.status).toBe(201);
    const { data: message } = await sent.json();
    for (const [agent, count] of [[target, 1], [other, 0]] as const) {
      const deliveries = await stack.app.request('/v1/deliveries', { headers: { authorization: `Bearer ${agent.token}` } });
      const { data } = await deliveries.json();
      expect(data.filter((d: {message_id: string}) => d.message_id === message.message_id)).toHaveLength(count);
    }
    await post(`/v1/channels/${route.name}/leave`, target.token);
    expect((await (await post(endpoint, ws.workspaceKey)).json()).data.members).toHaveLength(1);
  });
  it('never transfers a deleted identity subscription to a recreated name', async () => {
    const ws = await createWorkspace(stack.app, 'target-lifecycle');
    await registerAgent(stack.app, ws.workspaceKey, 'recreated-worker');
    const request = (path: string, method = 'POST', body?: unknown) => stack.app.request(path, {
      method, headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const endpoint = '/v1/agents/recreated-worker/subscription-channel';
    const old = (await (await request(endpoint)).json()).data;
    expect((await request('/v1/agents/recreated-worker', 'DELETE')).status).toBe(204);
    expect((await request(endpoint)).status).toBe(404);
    await registerAgent(stack.app, ws.workspaceKey, 'recreated-worker');
    const current = (await (await request(endpoint)).json()).data;
    expect(current.name).not.toBe(old.name);
    expect(current.members.map((m: { agent_name: string }) => m.agent_name)).toEqual(['recreated-worker']);
    const oldChannel = (await (await request(`/v1/channels/${old.name}`, 'GET')).json()).data;
    expect(oldChannel.members).toHaveLength(0);
    expect((await request(`/v1/channels/${current.name}`, 'PATCH', { metadata: { subscription_agent_id: 'another' } })).status).toBe(403);
  });

});
