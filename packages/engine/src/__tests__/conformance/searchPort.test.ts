import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../engine.js';
import type { MessageSearchQuery } from '../../ports/search.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/** Exercise actual authenticated HTTP -> adapter selection, not a mocked route. */
describe('message search adapter boundary', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function fixture(name: string) {
    const workspace = await createWorkspace(stack.app, name);
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const response = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'searchportneedle scoped fixture' }),
    });
    expect(response.status).toBe(201);
    return workspace;
  }

  it('preserves SQLite workspace scoping and unknown-filter refusal by default', async () => {
    const a = await fixture('search-port-a');
    await fixture('search-port-b');
    const request = async (suffix = '') => {
      const response = await stack.app.request('/v1/search?q=searchportneedle' + suffix, {
        headers: { authorization: `Bearer ${a.workspaceKey}` },
      });
      expect(response.status).toBe(200);
      return (await response.json() as { data: Array<{ text: string; channel_name: string }> }).data;
    };
    expect(await request()).toHaveLength(1);
    expect(await request('&channel=missing')).toEqual([]);
    expect(await request('&from=missing')).toEqual([]);
    expect(await request('&channel=general&from=alice')).toHaveLength(1);
  });

  it('passes authenticated workspace identity and parsed options to the supplied backend', async () => {
    const workspace = await createWorkspace(stack.app, 'search-port-custom');
    const searchMessages = vi.fn(async (_query: MessageSearchQuery) => []);
    const app = createEngine({ ...stack.runtime.deps, search: { searchMessages } });
    const response = await app.request('/v1/search?q=%20Needle%20&channel=general&from=alice&limit=3&before=10&after=2', {
      headers: { authorization: `Bearer ${workspace.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    expect(searchMessages).toHaveBeenCalledExactlyOnceWith({
      workspaceId: workspace.workspaceId, q: 'Needle', channel: 'general', from: 'alice', limit: 3, before: '10', after: '2',
    });
  });

  it('does not invoke a backend for unauthenticated or invalid requests', async () => {
    const workspace = await createWorkspace(stack.app, 'search-port-denied');
    const searchMessages = vi.fn(async (_query: MessageSearchQuery) => []);
    const app = createEngine({ ...stack.runtime.deps, search: { searchMessages } });
    expect((await app.request('/v1/search?q=needle')).status).toBe(401);
    expect((await app.request('/v1/search?q=%20', { headers: { authorization: `Bearer ${workspace.workspaceKey}` } })).status).toBe(400);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('does not silently fall back to SQLite when a configured backend fails', async () => {
    const workspace = await fixture('search-port-unavailable');
    const searchMessages = vi.fn(async (_query: MessageSearchQuery) => { throw new Error('configured search unavailable'); });
    const app = createEngine({ ...stack.runtime.deps, search: { searchMessages } });
    const response = await app.request('/v1/search?q=searchportneedle', { headers: { authorization: `Bearer ${workspace.workspaceKey}` } });
    expect(response.status).toBe(500);
    expect(searchMessages).toHaveBeenCalledOnce();
  });

  it('keeps search selection local to each engine instance', async () => {
    const workspace = await fixture('search-port-per-engine');
    const searchMessages = vi.fn(async (_query: MessageSearchQuery) => []);
    const custom = createEngine({ ...stack.runtime.deps, search: { searchMessages } });
    const options = { headers: { authorization: `Bearer ${workspace.workspaceKey}` } };
    const overridden = await custom.request('/v1/search?q=searchportneedle', options);
    expect((await overridden.json() as { data: unknown[] }).data).toEqual([]);
    const original = await stack.app.request('/v1/search?q=searchportneedle', options);
    expect((await original.json() as { data: unknown[] }).data).toHaveLength(1);
    expect(searchMessages).toHaveBeenCalledOnce();
  });
});
