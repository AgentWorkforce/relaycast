import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { agents } from '../../db/schema.js';

/**
 * Agent-scoped permissions (#453): an agent token can read the roster and the
 * fleet, and can release or delete the agents it spawned, so a spawned agent
 * does not need the workspace key. Everything else stays workspace-key only.
 */
describe('agent-scoped permissions', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  type Workspace = { workspaceKey: string; workspaceId: string };

  function request(path: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    return stack.app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  async function bringBrokerOnline(ws: Workspace, nodeId: string, name: string) {
    const enrolled = await request('/v1/nodes', ws.workspaceKey, {
      method: 'POST',
      body: { node_id: nodeId, name, role: 'broker', capabilities: ['spawn:claude'], max_agents: 16, tags: ['test'], version: 'v0' },
    });
    expect(enrolled.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 16, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  /** Answer the broker's `action.invoke` for a spawn the way the relay broker does. */
  async function registerSpawned(
    broker: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } },
    name: string,
    invocationId?: string,
  ) {
    await broker.handle.handleMessage(JSON.stringify({
      v: 1, id: `register-${name}`, type: 'agent.register', name, resumable: true,
      ...(invocationId ? { invocation_id: invocationId } : {}),
    }));
    const reply = broker.sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string; token: string } };
    expect(reply.ok).toBe(true);
    return { agentId: reply.data.agent_id, token: reply.data.token, name };
  }

  /** Spawn through the real path: an agent token invokes spawn, the broker registers the agent. */
  async function spawnAs(
    token: string,
    broker: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } },
    name: string,
  ) {
    const res = await request('/v1/actions/spawn/invoke', token, {
      method: 'POST',
      body: { input: { cli: 'claude', name } },
    });
    expect(res.status).toBe(201);
    const invocationId = (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(broker.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId });
    return registerSpawned(broker, name, invocationId);
  }

  async function spawnedBy(agentId: string) {
    const [row] = await stack.runtime.deps.db
      .select({ spawnedBy: agents.spawnedBy })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.spawnedBy;
  }

  async function errorCode(res: Response) {
    return (await res.json() as { error?: { code: string; message: string } }).error;
  }

  it('lets an agent token read the roster and fleet without secrets, while observer filters still apply', async () => {
    const ws = await createWorkspace(stack.app, 'scoped-read');
    const lead = await registerAgent(stack.app, ws.workspaceKey, 'lead');
    const peer = await registerAgent(stack.app, ws.workspaceKey, 'peer');
    const retired = await registerAgent(stack.app, ws.workspaceKey, 'retired');
    expect((await request('/v1/agents/retired', ws.workspaceKey, { method: 'DELETE' })).status).toBe(204);
    await bringBrokerOnline(ws, 'node_a', 'alpha');
    const hook = await request('/v1/nodes', ws.workspaceKey, {
      method: 'POST',
      body: {
        name: 'hook',
        kind: 'http_push',
        delivery: { url: 'https://receiver.example.test/relaycast', auth: { type: 'bearer', token: 'delivery-secret' } },
      },
    });
    expect(hook.status).toBe(201);

    const list = await request('/v1/agents', lead.token);
    expect(list.status).toBe(200);
    const roster = (await list.json() as { data: Array<Record<string, unknown>> }).data;
    expect(roster.map((agent) => agent.name).sort()).toEqual(['lead', 'peer']);
    expect(roster.map((agent) => agent.id)).not.toContain(retired.agentId);
    for (const agent of roster) expect(agent).not.toHaveProperty('token');

    const detail = await request('/v1/agents/peer', lead.token);
    expect(detail.status).toBe(200);
    expect((await detail.json() as { data: Record<string, unknown> }).data).toMatchObject({
      id: peer.agentId, name: 'peer', spawned_by: null,
    });
    expect((await request('/v1/agents/retired', lead.token)).status).toBe(404);

    const nodes = await request('/v1/nodes', lead.token);
    expect(nodes.status).toBe(200);
    const fleet = (await nodes.json() as { data: Array<Record<string, unknown>> }).data;
    expect(fleet.map((node) => node.name)).toEqual(expect.arrayContaining(['alpha', 'hook']));
    const serialized = JSON.stringify(fleet);
    expect(serialized).not.toContain('delivery-secret');
    expect(serialized).not.toContain('nt_live_');
    const hookNode = await request('/v1/nodes/hook', lead.token);
    expect(hookNode.status).toBe(200);
    expect((await hookNode.json() as { data: { delivery: { auth: Record<string, unknown> } } }).data.delivery.auth)
      .toEqual({ type: 'bearer', token: '[redacted]' });

    // Observer tokens keep their scope and agent filters on the same routes.
    const minted = await request('/v1/observer-tokens', ws.workspaceKey, {
      method: 'POST',
      body: { name: 'lead-only', scopes: ['agents:read'], filters: { agent_ids: [lead.agentId] } },
    });
    expect(minted.status).toBe(201);
    const observer = (await minted.json() as { data: { token: string } }).data.token;
    const observed = await request('/v1/agents', observer);
    expect(observed.status).toBe(200);
    expect((await observed.json() as { data: Array<{ name: string }> }).data.map((agent) => agent.name)).toEqual(['lead']);
    expect((await request('/v1/agents/peer', observer)).status).toBe(404);
    expect((await request('/v1/agents/lead', observer)).status).toBe(200);
    const unscoped = await request('/v1/observer-tokens', ws.workspaceKey, {
      method: 'POST',
      body: { name: 'channels-only', scopes: ['channels:read'] },
    });
    const channelsOnly = (await unscoped.json() as { data: { token: string } }).data.token;
    const denied = await request('/v1/agents', channelsOnly);
    expect(denied.status).toBe(403);
    expect((await errorCode(denied))?.code).toBe('insufficient_scope');
  });

  it('keeps workspace administration on the workspace key and says so', async () => {
    const ws = await createWorkspace(stack.app, 'scoped-admin');
    const lead = await registerAgent(stack.app, ws.workspaceKey, 'lead');

    for (const [path, method, body] of [
      ['/v1/agents', 'POST', { name: 'impostor' }],
      ['/v1/observer-tokens', 'POST', { name: 'watch', scopes: ['agents:read'] }],
      ['/v1/nodes', 'POST', { name: 'rogue', role: 'broker', capabilities: [], max_agents: 1 }],
      ['/v1/agents/lead', 'PATCH', { persona: 'changed' }],
      ['/v1/webhooks', 'POST', { name: 'hook', channel: 'general' }],
      ['/v1/directory/agents', 'POST', { name: 'listing' }],
      ['/v1/workspace', 'DELETE', undefined],
    ] as const) {
      const res = await request(path, lead.token, { method, body });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await errorCode(res))?.message, `${method} ${path}`).toMatch(/workspace key/i);
    }
    const events = await request('/v1/agents/lead/events', lead.token);
    expect(events.status).toBe(401);
    expect((await errorCode(events))?.message).toMatch(/workspace key/i);
  });

  it('records spawned_by on the real spawn path, only for the invoking agent', async () => {
    const ws = await createWorkspace(stack.app, 'scoped-spawn');
    const lead = await registerAgent(stack.app, ws.workspaceKey, 'lead');
    const broker = await bringBrokerOnline(ws, 'node_a', 'alpha');

    const worker = await spawnAs(lead.token, broker, 'worker');
    expect(await spawnedBy(worker.agentId)).toBe(lead.agentId);
    const detail = await request('/v1/agents/worker', lead.token);
    expect((await detail.json() as { data: { spawned_by: string | null } }).data.spawned_by).toBe(lead.agentId);
    const roster = await request('/v1/agents', worker.token);
    expect((await roster.json() as { data: Array<{ name: string; spawned_by: string | null }> }).data)
      .toContainEqual(expect.objectContaining({ name: 'worker', spawned_by: lead.agentId }));

    // POST /v1/agents/spawn with an agent token is the same invocation path.
    const viaRoute = await request('/v1/agents/spawn', lead.token, {
      method: 'POST',
      body: { name: 'route-worker', cli: 'claude', task: 'help' },
    });
    expect(viaRoute.status).toBe(201);
    const routeInvocation = (await viaRoute.json() as { data: { invocation_id: string } }).data.invocation_id;
    const routeWorker = await registerSpawned(broker, 'route-worker', routeInvocation);
    expect(await spawnedBy(routeWorker.agentId)).toBe(lead.agentId);

    // A workspace-key spawn has no spawning agent.
    const adminSpawn = await request('/v1/agents/spawn', ws.workspaceKey, {
      method: 'POST',
      body: { name: 'admin-worker', cli: 'claude', task: 'help' },
    });
    expect(adminSpawn.status).toBe(201);
    const adminInvocation = (await adminSpawn.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(await spawnedBy((await registerSpawned(broker, 'admin-worker', adminInvocation)).agentId)).toBeNull();

    // A registration that does not answer the invocation for that name is not attributed.
    const decoyInvoke = await request('/v1/actions/spawn/invoke', lead.token, {
      method: 'POST',
      body: { input: { cli: 'claude', name: 'decoy' } },
    });
    const decoyInvocation = (await decoyInvoke.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(await spawnedBy((await registerSpawned(broker, 'unrelated', decoyInvocation)).agentId)).toBeNull();
    expect(await spawnedBy((await registerSpawned(broker, 'uncorrelated')).agentId)).toBeNull();
  });

  it('lets an agent release and delete only the agents it spawned; the workspace key keeps full rights', async () => {
    const ws = await createWorkspace(stack.app, 'scoped-manage');
    const lead = await registerAgent(stack.app, ws.workspaceKey, 'lead');
    const peer = await registerAgent(stack.app, ws.workspaceKey, 'peer');
    const broker = await bringBrokerOnline(ws, 'node_a', 'alpha');
    const released = await spawnAs(lead.token, broker, 'released-worker');
    const deleted = await spawnAs(lead.token, broker, 'deleted-worker');
    const exact = await spawnAs(lead.token, broker, 'exact-worker');
    const peerWorker = await spawnAs(peer.token, broker, 'peer-worker');
    const releaseFrames = () => broker.sock.ofType('action.invoke').filter((frame) => frame.action === 'release');

    // Another agent is refused before anything is dispatched.
    for (const target of ['released-worker', 'deleted-worker']) {
      const release = await request('/v1/agents/release', peer.token, { method: 'POST', body: { name: target } });
      expect(release.status).toBe(403);
      expect(await errorCode(release)).toMatchObject({
        code: 'agent_not_spawned_by_caller',
        message: expect.stringMatching(/workspace key/i),
      });
      const remove = await request(`/v1/agents/${target}`, peer.token, { method: 'DELETE' });
      expect(remove.status).toBe(403);
      expect((await errorCode(remove))?.code).toBe('agent_not_spawned_by_caller');
    }
    const exactByPeer = await request('/v1/agents/release-exact', peer.token, {
      method: 'POST',
      headers: { 'idempotency-key': 'peer-exact' },
      body: { name: 'exact-worker', expected_agent_id: exact.agentId },
    });
    expect(exactByPeer.status).toBe(403);
    // A spawned agent does not own its sibling or its spawner.
    expect((await request('/v1/agents/release', released.token, { method: 'POST', body: { name: 'deleted-worker' } })).status).toBe(403);
    expect((await request('/v1/agents/lead', released.token, { method: 'DELETE' })).status).toBe(403);
    // Nor may an agent delete itself through the workspace-admin route.
    expect((await request('/v1/agents/lead', lead.token, { method: 'DELETE' })).status).toBe(403);
    expect(releaseFrames()).toHaveLength(0);
    expect(await spawnedBy(deleted.agentId)).toBe(lead.agentId);

    // The spawner may release and delete its own agents.
    const release = await request('/v1/agents/release', lead.token, { method: 'POST', body: { name: 'released-worker' } });
    expect(release.status).toBe(201);
    expect(releaseFrames().at(-1)).toMatchObject({ input: expect.objectContaining({ name: 'released-worker' }) });
    const exactRelease = await request('/v1/agents/release-exact', lead.token, {
      method: 'POST',
      headers: { 'idempotency-key': 'lead-exact' },
      body: { name: 'exact-worker', expected_agent_id: exact.agentId },
    });
    expect(exactRelease.status).toBe(201);
    expect((await request('/v1/agents/deleted-worker', lead.token, { method: 'DELETE' })).status).toBe(204);
    expect((await request('/v1/agents/deleted-worker', lead.token)).status).toBe(404);

    // Self-release is unchanged.
    expect((await request('/v1/agents/release', peerWorker.token, { method: 'POST', body: { name: 'peer-worker' } })).status).toBe(201);

    // The workspace key manages any agent, regardless of who spawned it.
    expect((await request('/v1/agents/peer-worker', ws.workspaceKey, { method: 'DELETE' })).status).toBe(204);
    expect((await request('/v1/agents/peer', ws.workspaceKey, { method: 'DELETE' })).status).toBe(204);

    // A missing target keeps its not-found answer.
    expect((await request('/v1/agents/ghost', lead.token, { method: 'DELETE' })).status).toBe(404);
  });
});
