import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  type TestStack,
} from './harness.js';

describe('node delivery contracts', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack({ ttlMs: 60_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  async function createHttpNode(workspaceKey: string, opts: {
    name?: string;
    ackMode?: 'manual' | 'on_2xx' | 'response';
    signatureHeader?: string;
    timestampHeader?: string;
  } = {}) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        name: opts.name ?? 'http-node',
        kind: 'http_push',
        delivery: {
          url: 'https://receiver.example.test/relaycast',
          ack_mode: opts.ackMode ?? 'manual',
          auth: {
            type: 'hmac_sha256',
            secret: 'test-secret',
            signature_header: opts.signatureHeader ?? 'X-Custom-Signature',
            timestamp_header: opts.timestampHeader ?? 'X-Custom-Timestamp',
            signed_payload: 'timestamp.body',
            prefix: 'sig=',
          },
        },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { data: { name: string; delivery: { auth: { secret: string } }; max_agents: number } };
  }

  async function bindAgent(workspaceKey: string, nodeName: string, agentName: string) {
    const res = await stack.app.request(`/v1/nodes/${nodeName}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ agent_name: agentName }),
    });
    return res;
  }

  it('dispatches to an http_push node with custom HMAC headers and manual ack semantics', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'http-node-manual');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey);
    expect(node.data.delivery.auth.secret).toBe('[redacted]');
    expect(node.data.max_agents).toBe(1);
    expect((await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status).toBe(201);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hello http' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://receiver.example.test/relaycast');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom-Timestamp']).toBeTruthy();
    expect(headers['X-Custom-Signature']).toMatch(/^sig=[a-f0-9]{64}$/);
    const body = JSON.parse(init.body as string) as {
      type: string;
      message_id: string;
      agent_name: string;
      delivery_id: string;
      data: { text: string };
    };
    expect(body).toMatchObject({
      type: 'message.created',
      message_id: messageId,
      agent_name: 'bob',
      data: { text: 'hello http' },
    });
    expect(body.delivery_id).toBeTruthy();

    const queued = await stack.app.request('/v1/deliveries', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(queued.status).toBe(200);
    const items = ((await queued.json()) as { data: Array<{ status: string; route_node_kind: string; delivery_adapter: string }> }).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'delivered',
      route_node_kind: 'http_push',
      delivery_adapter: 'http.hmac.v1',
    });
  });

  it('acks an http_push delivery when the node contract uses on_2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const ws = await createWorkspace(stack.app, 'http-node-on-2xx');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, { name: 'http-node-ack', ackMode: 'on_2xx' });
    expect((await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status).toBe(201);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'ack me' }),
    });
    expect(post.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const defaultQueue = await stack.app.request('/v1/deliveries', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(((await defaultQueue.json()) as { data: unknown[] }).data).toHaveLength(0);

    const acked = await stack.app.request('/v1/deliveries?status=acked', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(((await acked.json()) as { data: Array<{ status: string }> }).data).toEqual([
      expect.objectContaining({ status: 'acked' }),
    ]);
  });

  it('defaults http_push nodes to one active agent binding', async () => {
    const ws = await createWorkspace(stack.app, 'http-node-capacity');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const node = await createHttpNode(ws.workspaceKey, { name: 'single-http-node' });

    expect((await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status).toBe(201);
    const second = await bindAgent(ws.workspaceKey, node.data.name, 'carol');
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('node_capacity_exceeded');
  });
});
