import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { handleProviderDisconnect, markNodeOffline } from '../../node-control.js';
import { makeNodeStack, createWorkspace, FakeSocket, type TestStack } from './harness.js';
import { nodeProviders, nodes } from '../../db/schema.js';

// The provider-disconnect lifecycle is exported from @relaycast/engine/node-control
// so an out-of-process socket owner — the relaycast-cloud NodeDO — drives it on
// socket close instead of hand-rolling the SQL (the mirror the node-providers spec
// is removing). These assert the public exports produce the same DB liveness the
// in-process adapter's own close path produces.
describe('node-control provider-disconnect exports', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  const db = () => stack.runtime.handle.db;

  async function enrollNode(ws: { workspaceKey: string }, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  async function attachProvider(workspaceId: string, nodeId: string, nodeName: string, providerName: string, capability: string) {
    const provider = { name: providerName, instance_id: `${providerName}-i1` };
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `reg-${providerName}`,
      type: 'node.register',
      name: nodeName,
      node_id: nodeId,
      provider,
      capabilities: [{ name: capability, kind: 'action' }],
      max_agents: 4,
      tags: ['test'],
      version: 'v1',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', provider, load: 0, active_agents: 0, handlers_live: true }));
    return { sock, handle };
  }

  function providerStatuses(workspaceId: string, nodeId: string) {
    return db()
      .select({ name: nodeProviders.name, status: nodeProviders.status })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId)))
      .then((rows) => Object.fromEntries(rows.map((r) => [r.name, r.status])));
  }

  function nodeStatus(workspaceId: string, nodeId: string) {
    return db()
      .select({ status: nodes.status })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .then((rows) => rows[0]?.status);
  }

  it('handleProviderDisconnect (remaining connections) flips only that provider offline; node stays online', async () => {
    const ws = await createWorkspace(stack.app, 'exp-provider-remaining');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build');

    await handleProviderDisconnect(db(), stack.runtime.realtime, ws.workspaceId, 'node_a', 'py', true);

    expect(await providerStatuses(ws.workspaceId, 'node_a')).toEqual({ py: 'offline', rb: 'online' });
    expect(await nodeStatus(ws.workspaceId, 'node_a')).toBe('online');
  });

  it('handleProviderDisconnect (no remaining connections) marks the whole node offline', async () => {
    const ws = await createWorkspace(stack.app, 'exp-provider-last');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl');

    await handleProviderDisconnect(db(), stack.runtime.realtime, ws.workspaceId, 'node_a', 'py', false);

    expect(await providerStatuses(ws.workspaceId, 'node_a')).toEqual({ py: 'offline' });
    expect(await nodeStatus(ws.workspaceId, 'node_a')).toBe('offline');
  });

  it('markNodeOffline flips the node and every provider offline', async () => {
    const ws = await createWorkspace(stack.app, 'exp-node-offline');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build');

    await markNodeOffline(db(), stack.runtime.realtime, ws.workspaceId, 'node_a');

    expect(await providerStatuses(ws.workspaceId, 'node_a')).toEqual({ py: 'offline', rb: 'offline' });
    expect(await nodeStatus(ws.workspaceId, 'node_a')).toBe('offline');
  });
});
