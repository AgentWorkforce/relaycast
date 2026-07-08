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
  // Optional-chain so a failed beforeEach (undefined stack) surfaces its real
  // error instead of a TypeError from teardown.
  afterEach(() => stack?.close());

  const db = () => stack.runtime.handle.db;

  async function enrollNode(ws: { workspaceKey: string }, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  async function attachProvider(
    workspaceId: string,
    nodeId: string,
    nodeName: string,
    providerName: string,
    capability: string,
    activeAgents = 0,
  ) {
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
    await heartbeat(handle, providerName, activeAgents);
    return { sock, handle };
  }

  function heartbeat(handle: { handleMessage(raw: string): Promise<void> }, providerName: string, activeAgents: number) {
    return handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      provider: { name: providerName, instance_id: `${providerName}-i1` },
      load: 0,
      active_agents: activeAgents,
      handlers_live: true,
    }));
  }

  function nodeActiveAgents(workspaceId: string, nodeId: string) {
    return db()
      .select({ activeAgents: nodes.activeAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)))
      .then((rows) => rows[0]?.activeAgents);
  }

  function providerActiveAgents(workspaceId: string, nodeId: string, name: string) {
    return db()
      .select({ activeAgents: nodeProviders.activeAgents })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, workspaceId), eq(nodeProviders.nodeId, nodeId), eq(nodeProviders.name, name)))
      .then((rows) => rows[0]?.activeAgents);
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

  it('drops a disconnected provider from the node aggregate, and restores it on reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'exp-aggregate');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl', 2);
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build', 3);
    // The node aggregate sums both providers' active agents.
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(5);

    // py drops (others remain): its agents are gone, so the node aggregate must
    // no longer count them — recomputeNodeAggregate would resurrect them if the
    // provider row kept its stale activeAgents.
    await handleProviderDisconnect(db(), stack.runtime.realtime, ws.workspaceId, 'node_a', 'py', true);
    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'py')).toBe(0);
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(3);

    // Symmetric restore: py's next heartbeat repopulates its count.
    await heartbeat(py.handle, 'py', 2);
    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'py')).toBe(2);
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(5);
  });

  it('markNodeOffline zeros every provider active-agent count', async () => {
    const ws = await createWorkspace(stack.app, 'exp-node-offline-aggregate');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', 'run-etl', 2);
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', 'build', 3);

    await markNodeOffline(db(), stack.runtime.realtime, ws.workspaceId, 'node_a');

    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'py')).toBe(0);
    expect(await providerActiveAgents(ws.workspaceId, 'node_a', 'rb')).toBe(0);
    expect(await nodeActiveAgents(ws.workspaceId, 'node_a')).toBe(0);
  });
});
