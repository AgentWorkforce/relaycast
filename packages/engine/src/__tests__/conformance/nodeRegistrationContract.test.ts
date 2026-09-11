import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, channelMembers } from '../../db/schema.js';
import { makeNodeStack, createWorkspace, FakeSocket, type TestStack } from './harness.js';

describe('authenticated node registration contract', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { vi.restoreAllMocks(); await stack?.close(); });

  async function connect() {
    const ws = await createWorkspace(stack.app, 'registration-contract');
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: 'contract-node', name: 'contract-node', role: 'broker',
        capabilities: [], max_agents: 4, tags: [], version: 'test' }),
    });
    expect(enrolled.status).toBe(201);
    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'contract-node', socket);
    const send = (frame: Record<string, unknown>) => handle.handleMessage(JSON.stringify({ v: 1, ...frame }));
    const register = () => send({ id: 'node-request', type: 'node.register', node_id: 'contract-node',
      name: 'contract-node', provider: { name: 'broker', instance_id: 'contract-instance' },
      capabilities: [{ name: 'relay:node-registration-v1', kind: 'action' }], max_agents: 4,
      tags: [], version: 'test', resume_cursor: null });
    return { ws, socket, send, register };
  }

  it('announces server semantics and honors them through node create and guarded HTTP release', async () => {
    const { ws, socket, send, register } = await connect();
    await register();
    expect(socket.ofType('reply').find(frame => frame.id === 'node-request')).toMatchObject({
      data: { provider: { name: 'broker', instance_id: 'contract-instance' },
        registration_contract: 'relay:node-registration-v1' },
    });
    await send({ id: 'create-request', type: 'agent.register', name: 'contract-worker', auto_join_general: false });
    const reply = socket.ofType('reply').find(frame => frame.id === 'create-request') as
      { data: { agent_id: string; token: string; name: string } };
    expect(reply.data).toMatchObject({ name: 'contract-worker', agent_id: expect.any(String), token: expect.any(String) });
    const [owned] = await stack.runtime.handle.db.select().from(agents).where(eq(agents.id, reply.data.agent_id));
    expect(owned).toMatchObject({ providerName: 'broker', originNodeId: 'contract-node' });
    expect(await stack.runtime.handle.db.select().from(channelMembers).where(eq(channelMembers.agentId, owned.id))).toEqual([]);
    await send({ id: 'duplicate-request', type: 'agent.register', name: 'contract-worker' });
    expect(socket.ofType('error').find(frame => frame.id === 'duplicate-request')).toMatchObject({ code: 'agent_already_exists' });
    const rejected = await stack.app.request('/v1/agents/release', {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'contract-worker', expected_token_hash: '0'.repeat(64) }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: 'agent_release_generation_conflict' } });
    expect(await stack.runtime.handle.db.select().from(agents).where(eq(agents.id, owned.id))).toEqual([owned]);
    expect(socket.ofType('action.invoke')).toEqual([]);
  });

  it('does not announce support when the adapter cannot resolve the authenticated provider', async () => {
    const { socket, register } = await connect();
    vi.spyOn(stack.runtime.realtime, 'providerNameForConnection').mockReturnValue(undefined);
    await register();
    const reply = socket.ofType('reply').find(frame => frame.id === 'node-request') as { data: Record<string, unknown> };
    expect(reply.data).not.toHaveProperty('registration_contract');
  });
  it('omits the contract when the matching provider has no live attachment', async () => {
    const { socket, register } = await connect();
    vi.spyOn(stack.runtime.realtime, 'isProviderAttached').mockReturnValue(false);
    await register();
    const reply = socket.ofType('reply').find(frame => frame.id === 'node-request') as { data: Record<string, unknown> };
    expect(reply.data).not.toHaveProperty('registration_contract');
  });

});
