import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSchema } from '@relaycast/types';
import { makeNodeStack, createWorkspace, FakeSocket, type TestStack } from './harness.js';

// A service holding the workspace key (Cloud) must be able to tell which node
// spawned an agent from a field the agent cannot set, and to prove which node
// a node token belongs to. origin_node_id comes from the node's authenticated
// socket; metadata.fleet is patchable with the workspace key and proves nothing.

describe('agent node provenance', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack?.close(); });

  async function enrolledNode() {
    const ws = await createWorkspace(stack.app, 'provenance');
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: 'prov-node', name: 'prov-node', role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'test' }),
    });
    expect(enrolled.status).toBe(201);
    const { data } = await enrolled.json() as { data: { token: string } };
    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'prov-node', socket);
    const send = (frame: Record<string, unknown>) => handle.handleMessage(JSON.stringify({ v: 1, ...frame }));
    await send({ id: 'node-request', type: 'node.register', node_id: 'prov-node', name: 'prov-node',
      provider: { name: 'broker', instance_id: 'prov-instance' }, capabilities: [], max_agents: 4, tags: [], version: 'test', resume_cursor: null });
    return { ws, nodeToken: data.token, socket, send };
  }

  const read = (path: string, bearer: string, init: RequestInit = {}) =>
    stack.app.request(path, { ...init, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...init.headers } });

  it('reports the node that spawned an agent, and only that node', async () => {
    const { ws, socket, send } = await enrolledNode();
    await send({ id: 'spawn', type: 'agent.register', name: 'fleet-worker', auto_join_general: false });
    const spawned = socket.ofType('reply').find((frame) => frame.id === 'spawn') as { data: { agent_id: string } };
    const detail = await (await read('/v1/agents/fleet-worker', ws.workspaceKey)).json() as { data: Record<string, unknown> };
    expect(detail.data).toMatchObject({ id: spawned.data.agent_id, origin_node_id: 'prov-node' });
    // The shared schema carries it, so SDK consumers can read it.
    expect(AgentSchema.shape.origin_node_id.parse(detail.data.origin_node_id)).toBe('prov-node');

    // Rewriting the fleet metadata with the workspace key does not move it.
    const patched = await read('/v1/agents/fleet-worker', ws.workspaceKey, { method: 'PATCH', body: JSON.stringify({ metadata: { fleet: { node_id: 'other-node' } } }) });
    expect(patched.status).toBe(200);
    expect((await (await read('/v1/agents/fleet-worker', ws.workspaceKey)).json() as { data: Record<string, unknown> }).data.origin_node_id).toBe('prov-node');
  });

  it('never reports the node an HTTP-registered agent claims in its metadata', async () => {
    const { ws } = await enrolledNode();
    const created = await read('/v1/agents', ws.workspaceKey, { method: 'POST', body: JSON.stringify({ name: 'direct-worker', type: 'agent',
      metadata: { fleet: { node_id: 'prov-node' } } }) });
    expect(created.status).toBe(201);
    // It gets its own direct node, never the one its metadata names.
    const origin = (await (await read('/v1/agents/direct-worker', ws.workspaceKey)).json() as { data: Record<string, unknown> }).data.origin_node_id;
    expect(origin).toEqual(expect.stringMatching(/^node_direct_/));
  });

  it('names the node a node token belongs to, for the node token only', async () => {
    const { ws, nodeToken } = await enrolledNode();
    const me = await read('/v1/node/me', nodeToken);
    expect(me.status).toBe(200);
    expect((await me.json() as { data: unknown }).data).toEqual({ id: 'prov-node', name: 'prov-node', workspace_id: ws.workspaceId });
    expect((await read('/v1/node/me', ws.workspaceKey)).status).toBe(401);
    expect((await read('/v1/node/me', 'nt_live_not-a-real-token')).status).toBe(401);
  });
});
