import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  attachDirectNodeSocket,
  deliverFramesOfType,
  type TestStack,
} from './harness.js';
import { agentNodeBindings, agents, deliveries, nodes } from '../../db/schema.js';
import { sweepDueHttpPushDeliveries } from '../../routes/deliveryRouting.js';

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
        role: string;
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
    expect(node.data.role).toBe('direct');
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
    expect(init.redirect).toBe('error');
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

    const unbind = await stack.app.request(`/v1/nodes/${node.data.name}/agents/bob`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(unbind.status).toBe(204);
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'carol')).status,
    ).toBe(201);
  });

  it('redacts secret-like fields from every node delivery config shape', async () => {
    const ws = await createWorkspace(stack.app, 'node-delivery-redaction');
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: 'poll-with-secret-config',
        kind: 'poll',
        delivery: {
          endpoint: 'poll://local',
          api_key: 'top-secret',
          nested: { accessToken: 'nested-token', harmless: 'visible' },
          auth: {
            headers: {
              Authorization: 'Bearer secret',
              'Content-Type': 'application/json',
            },
          },
        },
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      data: {
        delivery: {
          endpoint: string;
          api_key: string;
          nested: { accessToken: string; harmless: string };
          auth: { headers: Record<string, string> };
        };
      };
    };
    expect(body.data.delivery.endpoint).toBe('poll://local');
    expect(body.data.delivery.api_key).toBe('[redacted]');
    expect(body.data.delivery.nested).toMatchObject({
      accessToken: '[redacted]',
      harmless: 'visible',
    });
    expect(body.data.delivery.auth.headers).toEqual({
      Authorization: '[redacted]',
      'Content-Type': '[redacted]',
    });
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
        role: string;
        delivery_adapter: string;
        delivery: { url: string; auth: { secret: string } };
        max_agents: number;
      };
    };
    expect(body.data.kind).toBe('http_push');
    expect(body.data.role).toBe('direct');
    expect(body.data.delivery_adapter).toBe('http.hmac.v1');
    expect(body.data.delivery.url).toBe(
      'https://receiver.example.test/relaycast',
    );
    expect(body.data.delivery.auth.secret).toBe('[redacted]');
    expect(body.data.max_agents).toBe(1);
  });

  it('rejects direct nodes with unlimited capacity', async () => {
    const ws = await createWorkspace(stack.app, 'direct-node-capacity-zero');
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: 'bad-direct-node',
        kind: 'http_push',
        role: 'direct',
        max_agents: 0,
        delivery: {
          url: 'https://receiver.example.test/relaycast',
          ack_mode: 'manual',
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'direct_node_capacity_exceeded' },
    });
  });

  it('does not clobber an explicit http_push binding when the agent opens /ws', async () => {
    const ws = await createWorkspace(stack.app, 'http-node-direct-ws');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'persistent-http-node',
    });
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);

    const [httpNode] = await stack.runtime.deps.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(
        eq(nodes.workspaceId, ws.workspaceId),
        eq(nodes.name, node.data.name),
      ));
    expect(httpNode?.id).toBeTruthy();

    const wsAttempt = await stack.app.request(`/v1/ws?token=${encodeURIComponent(bob.token)}`);
    expect(wsAttempt.status).toBe(426);

    const [agentRow] = await stack.runtime.deps.db
      .select({ locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(and(
        eq(agents.workspaceId, ws.workspaceId),
        eq(agents.id, bob.agentId),
      ));
    const activeBindings = await stack.runtime.deps.db
      .select({ nodeId: agentNodeBindings.nodeId })
      .from(agentNodeBindings)
      .where(and(
        eq(agentNodeBindings.workspaceId, ws.workspaceId),
        eq(agentNodeBindings.agentId, bob.agentId),
        eq(agentNodeBindings.status, 'active'),
      ));

    expect(agentRow?.locationNodeId).toBe(httpNode.id);
    expect(activeBindings.map((binding) => binding.nodeId)).toEqual([httpNode.id]);
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

  it('rejects an unsafe http_push url if the stored config changes before dispatch', async () => {
    stack.close();
    stack = makeNodeStack({ ttlMs: 60_000, environment: 'production' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'http-node-unsafe-redrive');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'unsafe-url-node',
    });
    expect(
      (await bindAgent(ws.workspaceKey, node.data.name, 'bob')).status,
    ).toBe(201);
    await stack.runtime.deps.db
      .update(nodes)
      .set({
        deliveryConfig: {
          url: 'http://169.254.169.254/latest/meta-data',
          ack_mode: 'manual',
          auth: { type: 'none' },
        },
      })
      .where(eq(nodes.name, node.data.name));

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ text: 'unsafe url' }),
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
          last_dispatch_error: 'unsafe http_push delivery url',
        }),
      ]);
      expect(items[0]?.next_attempt_at).toBeTruthy();
    });
  });

  it('redrives failed http_push deliveries when their retry time is due', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    const ws = await createWorkspace(stack.app, 'http-node-redrive');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'redrive-http-node',
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
      body: JSON.stringify({ text: 'retry me' }),
    });
    expect(post.status).toBe(201);

    await waitForAssertion(async () => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
          last_dispatch_error: 'HTTP 503',
        }),
      ]);
      expect(items[0]?.next_attempt_at).toBeTruthy();
    });

    const unbind = await stack.app.request(`/v1/nodes/${node.data.name}/agents/bob`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(unbind.status).toBe(204);

    const swept = await sweepDueHttpPushDeliveries(stack.runtime.deps, {
      now: new Date(Date.now() + 31_000),
    });
    expect(swept).toBe(1);

    await waitForAssertion(async () => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const queued = await stack.app.request('/v1/deliveries', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(
        ((await queued.json()) as { data: Array<{ status: string; dispatch_attempts: number }> }).data,
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          dispatch_attempts: 2,
        }),
      ]);
    });
  });

  it('claims a due http_push delivery only once across overlapping redrive sweeps', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const ws = await createWorkspace(stack.app, 'http-node-redrive-claim');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'redrive-claim-http-node',
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
      body: JSON.stringify({ text: 'retry once' }),
    });
    expect(post.status).toBe(201);
    await waitForAssertion(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await stack.runtime.deps.db
      .update(deliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(and(
        eq(deliveries.workspaceId, ws.workspaceId),
        eq(deliveries.agentId, bob.agentId),
      ));

    let releaseFetch: ((response: Response) => void) | undefined;
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    }));

    const sweep1 = sweepDueHttpPushDeliveries(stack.runtime.deps, { now: new Date() });
    const sweep2 = sweepDueHttpPushDeliveries(stack.runtime.deps, { now: new Date() });

    await waitForAssertion(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFetch?.(new Response('', { status: 202 }));
    await Promise.all([sweep1, sweep2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow http_push receiver block self-connected recipients', async () => {
    let releaseFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      }));
    const ws = await createWorkspace(stack.app, 'http-node-slow-isolation');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const { sock: carolSock } = await attachDirectNodeSocket(stack, ws.workspaceId, carol);
    const node = await createHttpNode(ws.workspaceKey, {
      name: 'slow-http-node',
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
      body: JSON.stringify({ text: 'do not block carol' }),
    });
    expect(post.status).toBe(201);

    await waitForAssertion(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitForAssertion(async () => {
      expect(deliverFramesOfType(carolSock, 'message.created')).toEqual([
        expect.objectContaining({
          type: 'deliver',
          payload: expect.objectContaining({
            type: 'message.created',
            data: expect.objectContaining({
              agent_id: alice.agentId,
              from_name: 'alice',
              text: 'do not block carol',
            }),
          }),
        }),
      ]);
      const carolQueue = await stack.app.request('/v1/deliveries', {
        headers: { authorization: `Bearer ${carol.token}` },
      });
      expect(
        ((await carolQueue.json()) as { data: Array<{ status: string }> }).data,
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
    });

    releaseFetch?.(new Response('', { status: 202 }));
    await waitForAssertion(async () => {
      const bobQueue = await stack.app.request('/v1/deliveries', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(
        ((await bobQueue.json()) as { data: Array<{ status: string }> }).data,
      ).toEqual([expect.objectContaining({ status: 'delivered' })]);
    });
  });
});
