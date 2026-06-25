import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  type TestStack,
} from './harness.js';
import { nodes } from '../../db/schema.js';

describe('node delivery contracts', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack({ ttlMs: 60_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  async function createHttpNode(
    workspaceKey: string,
    opts: {
      name?: string;
      ackMode?: 'manual' | 'on_2xx' | 'response';
      signatureHeader?: string;
      timestampHeader?: string;
    } = {},
  ) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspaceKey}`,
      },
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
    return (await res.json()) as {
      data: {
        name: string;
        kind: string;
        delivery_adapter: string;
        delivery: { url: string; auth: { secret: string } };
        max_agents: number;
      };
    };
  }

  async function bindAgent(
    workspaceKey: string,
    nodeName: string,
    agentName: string,
  ) {
    const res = await stack.app.request(`/v1/nodes/${nodeName}/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspaceKey}`,
      },
      body: JSON.stringify({ agent_name: agentName }),
    });
    return res;
  }

  async function waitForAssertion(
    assertion: () => void | Promise<void>,
    timeoutMs = 1_000,
  ) {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < timeoutMs) {
      try {
        await assertion();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError;
  }

  it('dispatches to an http_push node with custom HMAC headers and manual ack semantics', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'http-node-manual');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey);
    expect(node.data.delivery.auth.secret).toBe('[redacted]');
    expect(node.data.max_agents).toBe(1);
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ text: 'hello http' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await waitForAssertion(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://receiver.example.test/relaycast');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom-Timestamp']).toBeTruthy();
    const bodyText = init.body as string;
    const expectedSignature = createHmac('sha256', 'test-secret')
      .update(`${headers['X-Custom-Timestamp']}.${bodyText}`)
      .digest('hex');
    expect(headers['X-Custom-Signature']).toBe(`sig=${expectedSignature}`);
    const body = JSON.parse(bodyText) as {
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
    const items = (
      (await queued.json()) as {
        data: Array<{
          status: string;
          route_node_kind: string;
          delivery_adapter: string;
        }>;
      }
    ).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'delivered',
      route_node_kind: 'http_push',
      delivery_adapter: 'http.hmac.v1',
    });
  });

  it('acks an http_push delivery when the node contract uses on_2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const ws = await createWorkspace(stack.app, 'http-node-on-2xx');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'http-node-ack',
      ackMode: 'on_2xx',
    });
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ text: 'ack me' }),
    });
    expect(post.status).toBe(201);
    await waitForAssertion(async () => {
      const defaultQueue = await stack.app.request('/v1/deliveries', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(
        ((await defaultQueue.json()) as { data: unknown[] }).data,
      ).toHaveLength(0);

      const acked = await stack.app.request('/v1/deliveries?status=acked', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(
        ((await acked.json()) as { data: Array<{ status: string }> }).data,
      ).toEqual([expect.objectContaining({ status: 'acked' })]);
    });
  });

  it('acks an http_push delivery when the node contract uses response body ack', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ack: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const ws = await createWorkspace(stack.app, 'http-node-response-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'http-node-response',
      ackMode: 'response',
    });
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ text: 'ack by response' }),
    });
    expect(post.status).toBe(201);

    await waitForAssertion(async () => {
      const defaultQueue = await stack.app.request('/v1/deliveries', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(
        ((await defaultQueue.json()) as { data: unknown[] }).data,
      ).toHaveLength(0);

      const acked = await stack.app.request('/v1/deliveries?status=acked', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(
        ((await acked.json()) as { data: Array<{ status: string }> }).data,
      ).toEqual([expect.objectContaining({ status: 'acked' })]);
    });
  });

  it('defaults http_push nodes to one active agent binding', async () => {
    const ws = await createWorkspace(stack.app, 'http-node-capacity');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'single-http-node',
    });

    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);
    const second = await bindAgent(ws.workspaceKey, node.data.name, 'carol');
    expect(second.status).toBe(409);
    expect(
      ((await second.json()) as { error: { code: string } }).error.code,
    ).toBe('node_capacity_exceeded');
  });

  it('preserves an existing http_push contract during minimal token rotation', async () => {
    const ws = await createWorkspace(stack.app, 'http-node-rotate');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'rotating-http-node',
    });

    const rotate = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: node.data.name }),
    });
    expect(rotate.status).toBe(201);
    const body = (await rotate.json()) as {
      data: {
        kind: string;
        delivery_adapter: string;
        delivery: { url: string; auth: { secret: string } };
        max_agents: number;
      };
    };
    expect(body.data.kind).toBe('http_push');
    expect(body.data.delivery_adapter).toBe('http.hmac.v1');
    expect(body.data.delivery.url).toBe(
      'https://receiver.example.test/relaycast',
    );
    expect(body.data.delivery.auth.secret).toBe('[redacted]');
    expect(body.data.max_agents).toBe(1);
  });

  it('records retry diagnostics when an http_push config is invalid at dispatch time', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'http-node-invalid-config');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'invalid-config-node',
    });
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);
    await stack.runtime.deps.db
      .update(nodes)
      .set({ deliveryConfig: {} })
      .where(eq(nodes.name, node.data.name));

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ text: 'bad config' }),
    });
    expect(post.status).toBe(201);

    await waitForAssertion(async () => {
      expect(fetchMock).not.toHaveBeenCalled();
      const queued = await stack.app.request('/v1/deliveries', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      const items = (
        (await queued.json()) as {
          data: Array<{
            status: string;
            dispatch_attempts: number;
            next_attempt_at: string | null;
            last_dispatch_error: string | null;
          }>;
        }
      ).data;
      expect(items).toEqual([
        expect.objectContaining({
          status: 'queued',
          dispatch_attempts: 1,
          last_dispatch_error: 'invalid http_push delivery config: missing url',
        }),
      ]);
      expect(items[0]?.next_attempt_at).toBeTruthy();
    });
  });
});
