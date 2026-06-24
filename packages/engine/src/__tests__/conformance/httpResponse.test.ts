import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('route response helpers', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function createDeliveryForAgent(workspaceName: string, channelName: string) {
    const ws = await createWorkspace(stack.app, workspaceName);
    const alice = await registerAgent(stack.app, ws.workspaceKey, `${channelName}-alice`);
    const bob = await registerAgent(stack.app, ws.workspaceKey, `${channelName}-bob`);

    const createChannel = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: channelName }),
    });
    expect(createChannel.status).toBe(201);

    for (const token of [alice.token, bob.token]) {
      const join = await stack.app.request(`/v1/channels/${channelName}/join`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(join.status).toBe(200);
    }

    const post = await stack.app.request(`/v1/channels/${channelName}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alice.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'delivery helper test' }),
    });
    expect(post.status).toBe(201);

    const list = await stack.app.request('/v1/deliveries', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { data?: Array<{ id: string }> };
    expect(body.data?.length).toBeGreaterThan(0);

    return { deliveryId: body.data![0]!.id, token: bob.token };
  }

  it('returns invalid_json for malformed bodies handled by the shared parser', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-trigger-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'parser-agent');

    const res = await stack.app.request('/v1/triggers', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed bodies that still flow through route catches', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-channel-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'channel-agent');

    const res = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed channel update request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-channel-update-ws');

    const create = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'malformed-update-channel' }),
    });
    expect(create.status).toBe(201);

    const res = await stack.app.request('/v1/channels/malformed-update-channel', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('keeps custom validation messages when routes use the shared parser', async () => {
    const ws = await createWorkspace(stack.app, 'subscription-validation-ws');

    const missingEvents = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://example.test/relay' }),
    });

    expect(missingEvents.status).toBe(400);
    await expect(missingEvents.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'events array is required',
      },
    });
  });

  it('returns invalid_json for another route migrated to the shared parser', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-subscription-ws');

    const res = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed directory request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-directory-ws');

    const res = await stack.app.request('/v1/directory/agents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed file upload request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-file-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'file-agent');

    const res = await stack.app.request('/v1/files/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed direct message request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-dm-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'dm-agent');

    const res = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed channel message request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-message-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'message-agent');

    const res = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed group DM request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-group-dm-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'group-dm-agent');

    const res = await stack.app.request('/v1/dm/group', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed thread reply request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-thread-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'thread-agent');

    const createChannel = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'thread-helper-channel' }),
    });
    expect(createChannel.status).toBe(201);

    const join = await stack.app.request('/v1/channels/thread-helper-channel/join', {
      method: 'POST',
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(join.status).toBe(200);

    const post = await stack.app.request('/v1/channels/thread-helper-channel/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'parent message' }),
    });
    expect(post.status).toBe(201);
    const postBody = await post.json() as { data?: { id?: string } };
    expect(postBody.data?.id).toBeTruthy();

    const res = await stack.app.request(`/v1/messages/${postBody.data!.id}/replies`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('uses the shared invalid_request envelope for query validation', async () => {
    const ws = await createWorkspace(stack.app, 'invalid-console-query-ws');

    const res = await stack.app.request('/v1/console/messages?limit=not-a-number', {
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
      },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Invalid console message query',
      },
    });
  });

  it('supports optional delivery fail bodies through the shared parser', async () => {
    const delivery = await createDeliveryForAgent('delivery-parser-ws', 'delivery-parser-channel');

    const malformed = await stack.app.request(`/v1/deliveries/${delivery.deliveryId}/fail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${delivery.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'Invalid JSON body',
      },
    });

    const empty = await stack.app.request(`/v1/deliveries/${delivery.deliveryId}/fail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${delivery.token}` },
    });

    expect(empty.status).toBe(200);
    const emptyBody = await empty.json() as { data?: { status?: string } };
    expect(emptyBody.data?.status).toBe('failed');
  });

  it('returns invalid_json for malformed routing request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-routing-ws');

    const res = await stack.app.request('/v1/route', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed reaction request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-reaction-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'reaction-agent');

    const res = await stack.app.request('/v1/messages/missing/reactions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed inbound webhook request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-inbound-webhook-ws');

    const res = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed certification request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-certification-ws');

    const res = await stack.app.request('/v1/certify/monitor', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed optional action invocation bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-action-ws');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'action-agent');

    const res = await stack.app.request('/v1/actions/missing/invoke', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed agent update request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-agent-update-ws');
    await registerAgent(stack.app, ws.workspaceKey, 'updatable-agent');

    const res = await stack.app.request('/v1/agents/updatable-agent', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('returns invalid_json for malformed workspace update request bodies', async () => {
    const ws = await createWorkspace(stack.app, 'malformed-workspace-update-ws');

    const res = await stack.app.request('/v1/workspace', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${ws.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });
});
