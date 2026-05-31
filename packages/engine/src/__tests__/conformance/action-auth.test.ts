import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('action authorization', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('allows only the handler agent or workspace key to delete an action', async () => {
    const ws = await createWorkspace(stack.app, 'action-delete-auth');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const createRes = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        name: 'deploy',
        description: 'Deploy service',
        handler_agent: 'alice',
      }),
    });
    expect(createRes.status).toBe(201);

    const deniedRes = await stack.app.request('/v1/actions/deploy', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(deniedRes.status).toBe(403);

    const stillExistsRes = await stack.app.request('/v1/actions/deploy', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(stillExistsRes.status).toBe(200);

    const handlerDeleteRes = await stack.app.request('/v1/actions/deploy', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(handlerDeleteRes.status).toBe(204);
  });

  it('allows only the invoking agent, handler agent, or workspace key to read an invocation', async () => {
    const ws = await createWorkspace(stack.app, 'invocation-read-auth');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const charlie = await registerAgent(stack.app, ws.workspaceKey, 'charlie');

    const createRes = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({
        name: 'summarize',
        description: 'Summarize input',
        handler_agent: 'bob',
      }),
    });
    expect(createRes.status).toBe(201);

    const invokeRes = await stack.app.request('/v1/actions/summarize/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ input: { text: 'hello' } }),
    });
    expect(invokeRes.status).toBe(201);
    const invokeBody = await invokeRes.json() as { data: { invocation_id: string } };
    const invocationPath = `/v1/actions/summarize/invocations/${invokeBody.data.invocation_id}`;

    const deniedRes = await stack.app.request(invocationPath, {
      headers: { authorization: `Bearer ${charlie.token}` },
    });
    expect(deniedRes.status).toBe(403);

    for (const token of [alice.token, bob.token, ws.workspaceKey]) {
      const allowedRes = await stack.app.request(invocationPath, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(allowedRes.status).toBe(200);
    }
  });
});
