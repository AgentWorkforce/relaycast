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
});
