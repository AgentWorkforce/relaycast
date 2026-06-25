import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { deliverEvent } from '../../engine/eventDelivery.js';
import { webhooks } from '../../db/schema.js';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  attachDirectNodeSocket,
  deliverFramesOfType,
  type TestStack,
} from './harness.js';

describe('SDK v8 service contract', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  it('resolves the authenticated agent token and rejects duplicate agent names', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-agent-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

    const duplicate = await stack.app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'alice' }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent_already_exists' },
    });

    const me = await stack.app.request('/v1/agent', {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(me.status).toBe(200);
    const body = await me.json() as { data: { id: string; name: string; channels: Array<{ name: string }> } };
    expect(body.data.id).toBe(alice.agentId);
    expect(body.data.name).toBe('alice');
    expect(body.data.channels.map((c) => c.name)).toContain('general');
  });

  it('filters actions by available_to, enforces invoke access, and emits action events', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-action-ws');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'handler');
    const denied = await registerAgent(stack.app, ws.workspaceKey, 'denied');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: JSON.stringify({
        name: 'summarize',
        description: 'Summarize text',
        handler_agent: 'handler',
        available_to: ['caller'],
      }),
    });
    expect(register.status).toBe(201);

    const callerActions = await stack.app.request('/v1/actions', {
      headers: { authorization: `Bearer ${caller.token}` },
    });
    const callerBody = await callerActions.json() as { data: Array<{ name: string }> };
    expect(callerBody.data.map((a) => a.name)).toEqual(['summarize']);

    const deniedActions = await stack.app.request('/v1/actions', {
      headers: { authorization: `Bearer ${denied.token}` },
    });
    const deniedBody = await deniedActions.json() as { data: Array<{ name: string }> };
    expect(deniedBody.data).toEqual([]);

    const workspaceActions = await stack.app.request('/v1/actions', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const workspaceBody = await workspaceActions.json() as { data: Array<{ name: string }> };
    expect(workspaceBody.data).toEqual([]);

    const callerGet = await stack.app.request('/v1/actions/summarize', {
      headers: { authorization: `Bearer ${caller.token}` },
    });
    expect(callerGet.status).toBe(200);

    const deniedGet = await stack.app.request('/v1/actions/summarize', {
      headers: { authorization: `Bearer ${denied.token}` },
    });
    expect(deniedGet.status).toBe(404);

    const workspaceGet = await stack.app.request('/v1/actions/summarize', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(workspaceGet.status).toBe(404);

    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const invoke = await stack.app.request('/v1/actions/summarize/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { text: 'hello' } }),
    });
    expect(invoke.status).toBe(201);
    const invokeBody = await invoke.json() as { data: { invocation_id: string } };
    expect(invokeBody.data.invocation_id).toMatch(/^inv_/);

    await new Promise((r) => setTimeout(r, 50));
    expect(handlerNode.sock.ofType('action.invoke')).toHaveLength(1);
    expect(handlerNode.sock.ofType('action.invoke')[0]).toMatchObject({
      invocation_id: invokeBody.data.invocation_id,
      action: 'summarize',
      agent_id: handler.agentId,
      agent_name: 'handler',
      input: { text: 'hello' },
    });

    const deniedNode = await attachDirectNodeSocket(stack, ws.workspaceId, denied);
    const deniedInvoke = await stack.app.request('/v1/actions/summarize/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${denied.token}` },
      body: JSON.stringify({ input: { text: 'blocked' } }),
    });
    expect(deniedInvoke.status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(deliverFramesOfType(deniedNode.sock, 'action.denied')).toHaveLength(1);
  });

  it('requires inbound webhook tokens and accepts SDK message/author payloads', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-webhook-ws');

    const create = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general' }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { webhook_id: string; url: string; token: string } };
    expect(created.data.url).toContain(`/v1/hooks/${created.data.webhook_id}`);
    expect(created.data.token).toMatch(/^wh_live_/);

    const missingAuth = await stack.app.request(`/v1/hooks/${created.data.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'deploy started', author: 'CI' }),
    });
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await stack.app.request(`/v1/hooks/${created.data.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wh_live_wrong' },
      body: JSON.stringify({ message: 'deploy started', author: 'CI' }),
    });
    expect(wrongAuth.status).toBe(401);

    await stack.runtime.deps.db
      .update(webhooks)
      .set({ tokenHash: null })
      .where(eq(webhooks.id, created.data.webhook_id));
    const legacyTrigger = await stack.app.request(`/v1/hooks/${created.data.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'legacy deploy started', author: 'CI' }),
    });
    expect(legacyTrigger.status).toBe(201);

    const trigger = await stack.app.request(`/v1/hooks/${created.data.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.data.token}` },
      body: JSON.stringify({ message: 'deploy started', author: 'CI' }),
    });
    expect(trigger.status).toBe(201);
    const triggered = await trigger.json() as { data: { text: string; source: string | null; author: string } };
    expect(triggered.data).toMatchObject({ text: 'deploy started', source: null, author: 'CI' });

    const messages = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const messageBody = await messages.json() as { data: Array<{ text: string; agent_name: string }> };
    expect(messageBody.data[0]).toMatchObject({ text: 'deploy started', agent_name: 'CI' });
  });

  it('does not let caller-controlled metadata spoof REST message identity', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-spoof-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        text: 'ship it',
        data: {
          author: 'admin',
          __relaycast_origin: 'inbound_webhook',
          __relaycast_webhook_id: 'wh_fake',
          __relaycast_display_author: 'admin',
        },
      }),
    });
    expect(post.status).toBe(201);
    const posted = await post.json() as { data: { id: string; agent_name: string; metadata: Record<string, unknown> } };
    expect(posted.data.agent_name).toBe('alice');
    expect(posted.data.metadata).toEqual({ author: 'admin' });

    const getMessage = await stack.app.request(`/v1/messages/${posted.data.id}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const messageBody = await getMessage.json() as { data: { agent_name: string; metadata: Record<string, unknown> } };
    expect(messageBody.data.agent_name).toBe('alice');
    expect(messageBody.data.metadata).toEqual({ author: 'admin' });

    const reply = await stack.app.request(`/v1/messages/${posted.data.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        text: 'reply',
        data: {
          author: 'root',
          __relaycast_origin: 'inbound_webhook',
          __relaycast_webhook_id: 'wh_fake',
          __relaycast_display_author: 'root',
        },
      }),
    });
    expect(reply.status).toBe(201);

    const thread = await stack.app.request(`/v1/messages/${posted.data.id}/replies`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const threadBody = await thread.json() as {
      data: {
        parent: { agent_name: string; metadata: Record<string, unknown> };
        replies: Array<{ agent_name: string; metadata: Record<string, unknown> }>;
      };
    };
    expect(threadBody.data.parent.agent_name).toBe('alice');
    expect(threadBody.data.replies[0]).toMatchObject({
      agent_name: 'alice',
      metadata: { author: 'root' },
    });
  });

  it('passes subscription headers and signs delivery payloads with HMAC-SHA256', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-subscription-ws');
    const expectRedactedHeaders = (headers: Record<string, string>) => {
      expect(headers.Authorization).toBe('[redacted]');
      expect(headers['Content-Type']).toBe('[redacted]');
      expect(headers['x-relay-event']).toBe('[redacted]');
      expect(headers['X-Relay-Timestamp']).toBe('[redacted]');
      expect(Object.values(headers)).toSatisfy((values) => values.every((value) => value === '[redacted]'));
    };

    const invalidHeaders = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        events: ['message.created'],
        url: 'https://example.test/relay',
        headers: { 'Bad Header': 'x' },
      }),
    });
    expect(invalidHeaders.status).toBe(400);

    const create = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        events: ['message.created'],
        url: 'https://example.test/relay',
        headers: {
          Authorization: 'Bearer downstream',
          'Content-Type': 'text/plain',
          'x-relay-event': 'spoofed',
          'X-Relay-Timestamp': 'spoofed',
        },
        secret: 'shared-secret',
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { id: string; headers: Record<string, string> } };
    expectRedactedHeaders(created.data.headers);

    const list = await stack.app.request('/v1/subscriptions', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const listBody = await list.json() as { data: Array<{ id: string; headers: Record<string, string> }> };
    expect(listBody.data).toHaveLength(1);
    expectRedactedHeaders(listBody.data[0].headers);

    const get = await stack.app.request(`/v1/subscriptions/${created.data.id}`, {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const getBody = await get.json() as { data: { headers: Record<string, string> } };
    expectRedactedHeaders(getBody.data.headers);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await deliverEvent(stack.runtime.deps.db, ws.workspaceId, 'message.created', { text: 'hello' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer downstream');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Relay-Event']).toBe('message.created');
    expect(headers['x-relay-event']).toBeUndefined();
    expect(headers['X-Relay-Timestamp']).not.toBe('spoofed');
    expect(headers['X-Relay-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('keeps harness session event envelope types canonical', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-harness-ws');
    await registerAgent(stack.app, ws.workspaceKey, 'runner');
    const workspaceSock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, workspaceSock);

    const emit = await stack.app.request('/v1/agents/runner/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        type: 'tool.called',
        payload: { type: 'inner.tool', tool: 'build' },
      }),
    });
    expect(emit.status).toBe(201);

    await new Promise((r) => setTimeout(r, 50));
    expect(workspaceSock.ofType('harness.tool.called')).toHaveLength(1);
    expect(workspaceSock.ofType('inner.tool')).toHaveLength(0);
    expect(workspaceSock.ofType('harness.tool.called')[0]).toMatchObject({
      type: 'harness.tool.called',
      agent_name: 'runner',
      payload: { type: 'inner.tool', tool: 'build' },
    });
  });

  it('emits canonical message.reacted events for reactions', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-reaction-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'react here' }),
    });
    const posted = await post.json() as { data: { id: string } };

    const react = await stack.app.request(`/v1/messages/${posted.data.id}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ emoji: 'eyes' }),
    });
    expect(react.status).toBe(201);

    await new Promise((r) => setTimeout(r, 50));
    const delivered = deliverFramesOfType(bobSock, 'message.reacted');
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered[0]).toMatchObject({
      type: 'deliver',
      agent: 'bob',
      msg_id: posted.data.id,
      seq: 0,
      payload: {
        type: 'message.reacted',
        data: {
          message_id: posted.data.id,
          agent_name: 'bob',
          emoji: 'eyes',
          action: 'added',
        },
      },
    });
    expect(deliverFramesOfType(bobSock, 'reaction.added')).toHaveLength(0);
  });

  it('emits canonical message.read events over node delivery frames', async () => {
    const ws = await createWorkspace(stack.app, 'sdk-read-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'read here' }),
    });
    const posted = await post.json() as { data: { id: string } };

    const read = await stack.app.request(`/v1/messages/${posted.data.id}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(read.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    const delivered = deliverFramesOfType(bobSock, 'message.read');
    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered[0]).toMatchObject({
      type: 'deliver',
      agent: 'bob',
      msg_id: posted.data.id,
      seq: 0,
      payload: {
        type: 'message.read',
        data: {
          message_id: posted.data.id,
          agent_id: bob.agentId,
          agent_name: 'bob',
        },
      },
    });
  });
});
