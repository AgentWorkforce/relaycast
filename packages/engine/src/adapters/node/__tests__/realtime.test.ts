import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachDirectNodeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from '../../../__tests__/conformance/harness.js';

describe('InProcessRealtime direct node reconnect', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  it('brings the bound agent back with its node when the client re-registers after a disconnect', async () => {
    const ws = await createWorkspace(stack.app, 'reconnect');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const json = (method: string, path: string, token: string, body?: unknown) => stack.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const aliceStatus = async () => {
      const res = await json('GET', '/v1/agents', ws.workspaceKey);
      const { data } = await res.json() as { data: { name: string; status: string }[] };
      return data.find((agent) => agent.name === 'alice')?.status;
    };
    expect((await json('POST', '/v1/actions', ws.workspaceKey, { name: 'crm.lookup', description: 'Look someone up', handler_agent: 'alice' })).status).toBe(201);

    const first = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    expect(await aliceStatus()).toBe('active');
    // The socket drops: the teardown takes the node and its agent offline.
    await first.handle.handleClose();
    expect(await aliceStatus()).toBe('offline');

    // The client reconnects and re-registers; no heartbeat has been sent yet.
    const second = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    expect(await aliceStatus()).toBe('active');
    const invoked = await json('POST', '/v1/actions/crm.lookup/invoke', bob.token, { input: { name: 'ada' } });
    const body = await invoked.json() as { data: { status: string; invocation_id: string } };
    expect(invoked.status, JSON.stringify(body)).toBe(201);
    expect(body.data.status).toBe('dispatched');
    expect(second.sock.ofType('action.invoke')).toEqual([expect.objectContaining({ action: 'crm.lookup', invocation_id: body.data.invocation_id })]);
    expect(first.sock.ofType('action.invoke')).toEqual([]);
  });
});
