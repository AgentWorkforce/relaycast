import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('route response helpers', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

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
});
