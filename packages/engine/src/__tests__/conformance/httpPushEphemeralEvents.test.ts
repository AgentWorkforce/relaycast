import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  type TestStack,
} from './harness.js';

/**
 * Regression: an http_push node must receive the ephemeral channel/workspace
 * events a WebSocket node gets — reactions, read receipts, and presence/status
 * updates. These previously went through WS-only delivery paths
 * (`nodeDeliver`/`nodeContext` hard-filtered to ws/fleet_ws/direct_ws) and were
 * silently dropped for http_push receivers.
 */
describe('http_push ephemeral event delivery', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack({ ttlMs: 60_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  async function createHttpNode(workspaceKey: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        name,
        kind: 'http_push',
        delivery: { url: 'https://receiver.example.test/relaycast', ack_mode: 'manual', auth: { type: 'none' } },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { data: { name: string } };
  }

  async function bindAgent(workspaceKey: string, nodeName: string, agentName: string) {
    const res = await stack.app.request(`/v1/nodes/${nodeName}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ agent_name: agentName }),
    });
    expect(res.status).toBe(201);
  }

  async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 1000) {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < timeoutMs) {
      try { await assertion(); return; } catch (err) { lastError = err; await new Promise((r) => setTimeout(r, 10)); }
    }
    throw lastError;
  }

  function postsOfType(fetchMock: ReturnType<typeof vi.spyOn>, type: string): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .map((call) => {
        try { return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>; }
        catch { return null; }
      })
      .filter((body): body is Record<string, unknown> => !!body && body.type === type);
  }

  it('POSTs message.reacted to an http_push node', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'react-http');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, 'react-node');
    await bindAgent(ws.workspaceKey, node.data.name, 'bob');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'react to me' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await waitFor(() => expect(postsOfType(fetchMock, 'message.created')).toHaveLength(1));

    const react = await stack.app.request(`/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ emoji: '👍', channel_id: 'general' }),
    });
    expect(react.status).toBe(201);

    await waitFor(() => {
      const reacted = postsOfType(fetchMock, 'message.reacted');
      expect(reacted).toHaveLength(1);
      expect(reacted[0].data).toMatchObject({ emoji: '👍', agent_name: 'alice', action: 'added' });
    });
  });

  it('POSTs message.read to an http_push node', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'read-http');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, 'read-node');
    await bindAgent(ws.workspaceKey, node.data.name, 'bob');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'read me' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await waitFor(() => expect(postsOfType(fetchMock, 'message.created')).toHaveLength(1));

    // alice (a channel member) reads the message; bob's http_push node should
    // receive the read receipt for the channel.
    const read = await stack.app.request(`/v1/messages/${messageId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({}),
    });
    expect(read.status).toBe(200);

    await waitFor(() => {
      const reads = postsOfType(fetchMock, 'message.read');
      expect(reads.length).toBeGreaterThanOrEqual(1);
      expect(reads[0].data).toMatchObject({ agent_name: 'alice' });
    });
  });

  it('POSTs agent presence/status updates to an http_push node', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'presence-http');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, 'presence-node');
    await bindAgent(ws.workspaceKey, node.data.name, 'bob');

    // alice changes her status; bob (bound to the http_push node) should be
    // notified via a presence context POST.
    const patch = await stack.app.request('/v1/agents/alice', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ status: 'idle' }),
    });
    expect(patch.status).toBe(200);

    await waitFor(() => {
      const presence = postsOfType(fetchMock, 'agent.status.idle');
      expect(presence).toHaveLength(1);
      expect(presence[0]).toMatchObject({ topic: 'presence' });
      expect(presence[0].data).toMatchObject({ agent_name: 'alice', status: 'idle' });
    });
  });
});
