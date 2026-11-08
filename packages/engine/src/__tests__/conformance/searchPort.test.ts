import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../engine.js';
import type { MessageSearchQuery, MessageSearchResult } from '../../ports/search.js';
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

  it.each([['', 20], ['&limit=500', 100], ['&limit=1', 1]])(
    'normalizes the shared adapter result limit for %s', async (suffix, limit) => {
      const workspace = await createWorkspace(stack.app, 'search-port-limit');
      const searchMessages = vi.fn(async (_query: MessageSearchQuery) => []);
      const app = createEngine({ ...stack.runtime.deps, search: { searchMessages } });
      const response = await app.request('/v1/search?q=needle' + suffix, {
        headers: { authorization: `Bearer ${workspace.workspaceKey}` },
      });
      expect(response.status).toBe(200);
      expect(searchMessages).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ limit }));
    },
  );

  it('filters mixed adapter results for restricted observers and removes internal fields', async () => {
    const workspace = await createWorkspace(stack.app, 'search-port-observer');
    const alice = await registerAgent(stack.app, workspace.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, workspace.workspaceKey, 'bob');
    const makeResult = (id: string, channel: string, agentId: string): MessageSearchResult & { internal_notes: string } => ({
      id, channel_id: `channel-${channel}`, channel_name: channel, channel_type: 0,
      conversation_id: null, agent_id: agentId, agent_name: agentId === alice.agentId ? 'alice' : 'bob',
      text: id, created_at: '2026-11-07T00:00:00.000Z', relevance_score: -1,
      internal_notes: 'must-not-leak',
    });
    const searchMessages = vi.fn(async (_query: MessageSearchQuery) => [
      makeResult('visible-result', 'general', alice.agentId),
      makeResult('hidden-channel-result', 'team-only', alice.agentId),
      makeResult('hidden-agent-result', 'general', bob.agentId),
    ]);
    const app = createEngine({ ...stack.runtime.deps, search: { searchMessages } });
    const issued = await app.request('/v1/observer-tokens', {
      method: 'POST', headers: { authorization: `Bearer ${workspace.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'restricted-search', scopes: ['search:read'],
        filters: { channel_names: ['general'], agent_ids: [alice.agentId] } }),
    });
    expect(issued.status).toBe(201);
    const { data: { token } } = await issued.json() as { data: { token: string } };
    const response = await app.request('/v1/search?q=needle', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    expect(searchMessages).toHaveBeenCalledOnce();
    expect(searchMessages.mock.calls[0][0].workspaceId).toBe(workspace.workspaceId);
    expect(body.data.map(row => row.id)).toEqual(['visible-result']);
    expect(body.data[0]).not.toHaveProperty('agent_id');
    expect(body.data[0]).not.toHaveProperty('channel_type');
    expect(body.data[0]).not.toHaveProperty('internal_notes');
    expect(Object.keys(body.data[0]).sort()).toEqual([
      'id', 'channel_id', 'channel_name', 'conversation_id', 'agent_name', 'text', 'created_at', 'relevance_score',
    ].sort());
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(JSON.stringify(body)).not.toContain('hidden-channel-result');
    expect(JSON.stringify(body)).not.toContain('hidden-agent-result');
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
