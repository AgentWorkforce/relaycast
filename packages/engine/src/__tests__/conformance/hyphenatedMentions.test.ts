import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

describe('exact mention delivery', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  it.each(['channel', 'thread'])('wakes the full muted handle once on %s, never its prefix or a nonmember', async (kind) => {
    const ws = await createWorkspace(stack.app, 'mention-scope');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-proof_alpha-0908');
    const prefix = await registerAgent(stack.app, ws.workspaceKey, 'gh');
    const outside = await registerAgent(stack.app, ws.workspaceKey, 'gh-proof-outside');
    const request = (path: string, token: string, body?: unknown) => stack.app.request(path, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect((await request('/v1/channels', sender.token, { name: 'scoped' })).status).toBe(201);
    for (const agent of [target, prefix]) {
      expect((await request('/v1/channels/scoped/join', agent.token)).status).toBeLessThan(300);
      expect((await request('/v1/channels/scoped/mute', agent.token)).status).toBeLessThan(300);
    }
    let endpoint = '/v1/channels/scoped/messages';
    if (kind === 'thread') {
      const parent = await request(endpoint, sender.token, { text: 'thread root' });
      endpoint = '/v1/messages/' + (await parent.json()).data.id + '/replies';
    }
    const post = await request(endpoint, sender.token, {
      text: '@gh-proof_alpha-0908 @gh-proof_alpha-0908 @gh-proof-outside \\@gh sender@gh',
    });
    expect(post.status).toBe(201);
    const body = await post.json() as { data: { id: string; mentions: string[] } };
    if (kind === 'channel') expect(body.data.mentions).toEqual(['gh-proof_alpha-0908', 'gh-proof-outside']);
    for (const [agent, count] of [[target, 1], [prefix, 0], [outside, 0]] as const) {
      const response = await stack.app.request('/v1/deliveries', { headers: { authorization: `Bearer ${agent.token}` } });
      expect(response.status).toBe(200);
      const data = await response.json() as { data: Array<{ message_id: string; reason: string }> };
      const matching = data.data.filter(row => row.message_id === body.data.id);
      expect(matching).toHaveLength(count);
      if (count) expect(matching[0].reason).toBe('mention');
    }
    const foreignWorkspace = await createWorkspace(stack.app, 'foreign');
    const foreign = await registerAgent(stack.app, foreignWorkspace.workspaceKey, 'foreign');
    const unauthorized = await request('/v1/channels/scoped/messages', foreign.token, { text: '@gh-proof_alpha-0908' });
    expect(unauthorized.status).toBe(404);
  });
});
