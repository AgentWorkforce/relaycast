import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { parseAgentAddress } from '../../engine/address.js';

/**
 * POST /v1/to/:address — send a DM to `agent@machine`, where `machine` is the
 * agent's current node, by node name or machine_id.
 */
describe('addressed send', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => {
    await stack.close();
  });

  async function seed() {
    const ws = await createWorkspace(stack.app, 'address-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

    const nodeId = 'node_laptop';
    const nodeName = 'laptop';
    const enroll = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId,
        name: nodeName,
        machine_id: 'mach-123',
        capabilities: ['spawn:claude'],
        max_agents: 4,
        version: 'test-node',
      }),
    });
    expect(enroll.status).toBe(201);

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name: nodeName, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: [], version: 'test-node', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'agent.register', name: 'bob', resumable: true, session_ref: 'sess-bob',
    }));
    const reply = sock.ofType('reply').at(-1) as { ok: boolean };
    expect(reply?.ok).toBe(true);

    return { ws, alice, sock };
  }

  function send(token: string, address: string, body: unknown) {
    return stack.app.request(`/v1/to/${encodeURIComponent(address)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('parses agent@machine on the last @', () => {
    expect(parseAgentAddress('bob@laptop')).toEqual({ agent: 'bob', machine: 'laptop' });
    expect(parseAgentAddress('a@b@laptop')).toEqual({ agent: 'a@b', machine: 'laptop' });
    expect(parseAgentAddress('bob')).toBeNull();
    expect(parseAgentAddress('@laptop')).toBeNull();
    expect(parseAgentAddress('bob@')).toBeNull();
  });

  it('routes to the agent by node name and by machine_id', async () => {
    const { alice, sock } = await seed();

    for (const address of ['bob@laptop', 'bob@mach-123']) {
      const res = await send(alice.token, address, { text: `hi via ${address}` });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { ok: boolean; data: { text: string } };
      expect(body.ok).toBe(true);
      expect(body.data.text).toBe(`hi via ${address}`);
    }

    await stack.settle();
    const delivered = sock.ofType('deliver')
      .map((frame: { payload?: { type?: string; data?: { message?: { text?: string } } } }) => frame.payload)
      .filter((payload) => payload?.type === 'dm.received')
      .map((payload) => payload?.data?.message?.text);
    expect(delivered).toEqual(['hi via bob@laptop', 'hi via bob@mach-123']);
  });

  it('rejects an address whose machine does not host the agent', async () => {
    const { alice } = await seed();
    const res = await send(alice.token, 'bob@desktop', { text: 'hi' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('address_not_found');
  });

  it('rejects unknown agents and malformed addresses', async () => {
    const { alice } = await seed();
    const unknown = await send(alice.token, 'carol@laptop', { text: 'hi' });
    expect(unknown.status).toBe(404);

    const malformed = await send(alice.token, 'bob', { text: 'hi' });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe('invalid_address');
  });

  it('requires text', async () => {
    const { alice } = await seed();
    const res = await send(alice.token, 'bob@laptop', {});
    expect(res.status).toBe(400);
  });
});
