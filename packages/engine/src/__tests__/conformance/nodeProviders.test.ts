import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  deliverFramesOfType,
  contextUpdatesOfType,
  type TestStack,
} from './harness.js';
import { actions, agents, nodeProviders, nodes } from '../../db/schema.js';

type Cap = { name: string; kind?: string; global?: boolean; queue?: boolean };

/**
 * Multi-provider node model: N provider sockets per node, node-scoped actions,
 * node-addressed invoke, spawn shadowing, per-provider liveness, and provider
 * deregister/pruning. The synthetic `default` provider keeps the pre-provider
 * broker working.
 */
describe('node providers', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function enrollNode(ws: { workspaceKey: string }, nodeId: string, name: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
  }

  function attachSocket(workspaceId: string, nodeId: string) {
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
    return { sock, handle };
  }

  function registerFrame(nodeId: string, name: string, provider: { name: string; instance_id: string } | undefined, capabilities: Cap[], maxAgents = 4) {
    return JSON.stringify({
      v: 1,
      id: `reg-${provider?.name ?? 'default'}-${provider?.instance_id ?? '0'}`,
      type: 'node.register',
      name,
      node_id: nodeId,
      ...(provider ? { provider } : {}),
      capabilities,
      max_agents: maxAgents,
      tags: ['test'],
      version: 'v1',
      resume_cursor: null,
    });
  }

  async function attachProvider(
    workspaceId: string,
    nodeId: string,
    nodeName: string,
    providerName: string | undefined,
    capabilities: Cap[],
    opts: { instanceId?: string; maxAgents?: number } = {},
  ) {
    const provider = providerName ? { name: providerName, instance_id: opts.instanceId ?? `${providerName}-i1` } : undefined;
    const { sock, handle } = attachSocket(workspaceId, nodeId);
    await handle.handleMessage(registerFrame(nodeId, nodeName, provider, capabilities, opts.maxAgents));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', ...(provider ? { provider } : {}), load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  it('keys a registration with no provider field to the synthetic default provider', async () => {
    const ws = await createWorkspace(stack.app, 'np-default');
    await enrollNode(ws, 'node_a', 'alpha');
    const { sock, handle } = attachSocket(ws.workspaceId, 'node_a');
    await handle.handleMessage(registerFrame('node_a', 'alpha', undefined, [{ name: 'run-etl', kind: 'action' }]));

    const reply = sock.ofType('reply').at(-1) as { data?: { provider?: { name?: string }; accepted_capabilities?: unknown[] } };
    expect(reply.data?.provider?.name).toBe('default');
    expect(reply.data?.accepted_capabilities).toEqual([
      expect.objectContaining({ name: 'run-etl', kind: 'action', accepted: true }),
    ]);

    const providers = await stack.runtime.handle.db
      .select({ name: nodeProviders.name })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, ws.workspaceId), eq(nodeProviders.nodeId, 'node_a')));
    expect(providers).toEqual([{ name: 'default' }]);
  });

  it('attaches, replaces on reconnect, and rejects a duplicate live instance', async () => {
    const ws = await createWorkspace(stack.app, 'np-attach');
    await enrollNode(ws, 'node_a', 'alpha');

    const first = attachSocket(ws.workspaceId, 'node_a');
    await first.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'i1' }, [{ name: 'run-etl', kind: 'action' }]));
    expect(first.sock.ofType('reply').at(-1)).toMatchObject({ ok: true });

    // Duplicate: a second connection claims `py` while i1 is still live.
    const dup = attachSocket(ws.workspaceId, 'node_a');
    await dup.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'i2' }, [{ name: 'run-etl', kind: 'action' }]));
    expect(dup.sock.ofType('error').at(-1)).toMatchObject({ code: 'provider_instance_conflict' });

    // Reconnect: i1 drops, a new instance replaces the attachment.
    await first.handle.handleClose();
    const reconnect = attachSocket(ws.workspaceId, 'node_a');
    await reconnect.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'i3' }, [{ name: 'run-etl', kind: 'action' }]));
    expect(reconnect.sock.ofType('reply').at(-1)).toMatchObject({ ok: true });
    const [provider] = await stack.runtime.handle.db
      .select({ instanceId: nodeProviders.instanceId })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, ws.workspaceId), eq(nodeProviders.nodeId, 'node_a'), eq(nodeProviders.name, 'py')));
    expect(provider.instanceId).toBe('i3');
  });

  it('rejects a second provider registering an action another provider already owns on the node', async () => {
    const ws = await createWorkspace(stack.app, 'np-conflict');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);

    const rb = attachSocket(ws.workspaceId, 'node_a');
    await rb.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'rb', instance_id: 'rb-i1' }, [{ name: 'run-etl', kind: 'action' }]));
    expect(rb.sock.ofType('error').at(-1)).toMatchObject({ code: 'action_name_conflict' });
  });

  it('materializes only action-kind capabilities; capacity entries feed placement', async () => {
    const ws = await createWorkspace(stack.app, 'np-kind');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [
      { name: 'run-etl', kind: 'action' },
      { name: 'deploy' }, // inferred action
      { name: 'spawn:claude', kind: 'capacity' },
      { name: 'spawn:codex' }, // inferred capacity
      { name: 'release' }, // inferred capacity
    ]);

    const rows = await stack.runtime.handle.db
      .select({ name: actions.name })
      .from(actions)
      .where(eq(actions.workspaceId, ws.workspaceId));
    expect(rows.map((r) => r.name).sort()).toEqual(['deploy', 'run-etl']);
  });

  it('routes a node-addressed invoke to the provider that registered the action', async () => {
    const ws = await createWorkspace(stack.app, 'np-invoke');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);

    const res = await stack.app.request('/v1/nodes/alpha/actions/run-etl/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { rows: 3 } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { invocation_id: string } };
    expect(py.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: body.data.invocation_id, action: 'run-etl' });
    expect(rb.sock.ofType('action.invoke')).toHaveLength(0);
  });

  it('shadows native spawn capacity with a provider action and never silently bypasses it', async () => {
    const ws = await createWorkspace(stack.app, 'np-shadow');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    // Broker provider offers native spawn:claude capacity.
    const broker = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    // Policy provider shadows it with a spawn:claude action.
    const policy = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'policy', [{ name: 'spawn:claude', kind: 'action' }]);

    const spawn = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude', name: 'worker-1' } }),
    });
    expect(spawn.status).toBe(201);
    const body = await spawn.json() as { data: { invocation_id: string } };
    expect(policy.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: body.data.invocation_id, action: 'spawn:claude' });
    expect(broker.sock.ofType('action.invoke')).toHaveLength(0);

    // Shadow provider offline -> fail fast; never falls back to native capacity.
    await policy.handle.handleClose();
    broker.sock.received.length = 0;
    const blocked = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude', name: 'worker-2' } }),
    });
    expect(blocked.status).toBe(503);
    expect(broker.sock.ofType('action.invoke')).toHaveLength(0);
  });

  it('gates capability liveness per provider', async () => {
    const ws = await createWorkspace(stack.app, 'np-liveness');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);

    // py drops; rb stays live. The node still shows both capabilities.
    await py.handle.handleClose();
    const manifest = await stack.runtime.handle.db
      .select({ capabilities: nodes.capabilities })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')))
      .then((r) => r[0]);
    expect(manifest.capabilities.map((c) => c.name).sort()).toEqual(['build', 'run-etl']);

    const etl = await stack.app.request('/v1/nodes/alpha/actions/run-etl/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: {} }),
    });
    expect(etl.status).toBe(503); // py offline -> fail fast

    const build = await stack.app.request('/v1/nodes/alpha/actions/build/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: {} }),
    });
    expect(build.status).toBe(201);
    expect(rb.sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'build' });
  });

  it('queues an invoke for an offline provider when the capability opts into queue', async () => {
    const ws = await createWorkspace(stack.app, 'np-queue');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action', queue: true }]);

    await py.handle.handleClose();
    const res = await stack.app.request('/v1/nodes/alpha/actions/run-etl/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(201);
    expect((await res.json() as { data: { status: string } }).data.status).toBe('pending');
  });

  it('routes deliver frames to the provider whose connection registered the agent', async () => {
    const ws = await createWorkspace(stack.app, 'np-deliver');
    const poster = await registerAgent(stack.app, ws.workspaceKey, 'poster');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);

    // Register a worker agent over the py connection: it binds agent -> py.
    await py.handle.handleMessage(JSON.stringify({ v: 1, id: 'agent-1', type: 'agent.register', name: 'worker', session_ref: 'pty://py/worker' }));
    expect(py.sock.ofType('reply').at(-1)).toMatchObject({ ok: true, data: expect.objectContaining({ name: 'worker' }) });
    const [worker] = await stack.runtime.handle.db
      .select({ providerName: agents.providerName })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, 'worker')));
    expect(worker.providerName).toBe('py');

    py.sock.received.length = 0;
    rb.sock.received.length = 0;
    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${poster.token}` },
      body: JSON.stringify({ text: 'hello worker' }),
    });
    expect(post.status).toBe(201);
    // Poll for the async fanout instead of a fixed sleep, to avoid CI flakiness.
    for (let i = 0; i < 50 && deliverFramesOfType(py.sock, 'message.created').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(deliverFramesOfType(py.sock, 'message.created').length).toBeGreaterThanOrEqual(1);
    expect(deliverFramesOfType(rb.sock, 'message.created')).toHaveLength(0);
  });

  it('releases reserved capacity when a fail-fast node-scoped spawn hits an offline provider', async () => {
    const ws = await createWorkspace(stack.app, 'np-failfast-capacity');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    // Broker provides native capacity so the node is online with capacity.
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [{ name: 'spawn:claude', kind: 'capacity' }], { maxAgents: 4 });
    // A shadow spawn:claude action whose provider then goes offline.
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'spawn:claude', kind: 'action' }]);
    await py.handle.handleClose();

    const res = await stack.app.request('/v1/nodes/alpha/actions/spawn:claude/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { name: 'w1' } }),
    });
    expect(res.status).toBe(503);

    const [node] = await stack.runtime.handle.db
      .select({ reserved: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')));
    expect(node.reserved).toBe(0);
  });

  it('does not release another spawn’s reservation when a shadowed spawn completes', async () => {
    const ws = await createWorkspace(stack.app, 'np-shadow-capacity');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    // Broker offers native capacity for two harnesses; policy shadows only claude.
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [
      { name: 'spawn:claude', kind: 'capacity' },
      { name: 'spawn:codex', kind: 'capacity' },
    ], { maxAgents: 4 });
    const policy = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'policy', [{ name: 'spawn:claude', kind: 'action' }]);

    // A native codex spawn reserves capacity and stays in flight.
    const codex = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'codex', name: 'codex-1' } }),
    });
    expect(codex.status).toBe(201);
    const reservedAfterCodex = await stack.runtime.handle.db
      .select({ reserved: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')))
      .then((r) => r[0].reserved);
    expect(reservedAfterCodex).toBe(1);

    // A shadowed claude spawn dispatches to policy (holds no native reservation).
    const claude = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude', name: 'claude-1' } }),
    });
    expect(claude.status).toBe(201);
    const claudeInv = (await claude.json() as { data: { invocation_id: string } }).data.invocation_id;

    // Completing the shadow spawn must not release the codex spawn's reservation.
    await policy.handle.handleMessage(JSON.stringify({ v: 1, type: 'action.result', invocation_id: claudeInv, output: { ok: true } }));
    const reservedAfterClaude = await stack.runtime.handle.db
      .select({ reserved: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')))
      .then((r) => r[0].reserved);
    expect(reservedAfterClaude).toBe(1);
  });

  it('rejects an explicit global alias that would shadow an agent-hosted action', async () => {
    const ws = await createWorkspace(stack.app, 'np-global-conflict');
    const helper = await registerAgent(stack.app, ws.workspaceKey, 'helper');
    const reg = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${helper.token}` },
      body: JSON.stringify({ name: 'run-etl', description: 'agent hosted', handler_agent: 'helper' }),
    });
    expect(reg.status).toBe(201);

    await enrollNode(ws, 'node_a', 'alpha');
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_a', sock);
    await handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'py-i1' }, [{ name: 'run-etl', kind: 'action', global: true }]));
    expect(sock.ofType('error').at(-1)).toMatchObject({ code: 'action_name_conflict' });
  });

  it('routes context.update to the provider hosting the agent, not a phantom node default', async () => {
    const ws = await createWorkspace(stack.app, 'np-context');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);
    await py.handle.handleMessage(JSON.stringify({ v: 1, id: 'agent-1', type: 'agent.register', name: 'worker', session_ref: 'pty://py/worker' }));

    py.sock.received.length = 0;
    rb.sock.received.length = 0;
    await stack.runtime.presence.heartbeat(ws.workspaceId, alice.agentId, 'alice');
    await new Promise((r) => setTimeout(r, 40));

    expect(contextUpdatesOfType(py.sock, 'agent.status.active').length).toBeGreaterThanOrEqual(1);
    expect(contextUpdatesOfType(rb.sock, 'agent.status.active')).toHaveLength(0);
  });

  it('provider-scoped deregister removes its attachment, capabilities, and actions', async () => {
    const ws = await createWorkspace(stack.app, 'np-deregister');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);

    await py.handle.handleMessage(JSON.stringify({ v: 1, type: 'node.deregister', provider: { name: 'py', instance_id: 'py-i1' } }));

    const providers = await stack.runtime.handle.db
      .select({ name: nodeProviders.name })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, ws.workspaceId), eq(nodeProviders.nodeId, 'node_a')));
    expect(providers.map((p) => p.name)).toEqual(['rb']);

    const actionRows = await stack.runtime.handle.db
      .select({ name: actions.name })
      .from(actions)
      .where(eq(actions.workspaceId, ws.workspaceId));
    expect(actionRows.map((a) => a.name).sort()).toEqual(['build']);
  });

  it('fully replaces a provider capability set on re-register, pruning dropped actions', async () => {
    const ws = await createWorkspace(stack.app, 'np-prune');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [
      { name: 'run-etl', kind: 'action' },
      { name: 'sync', kind: 'action' },
    ]);

    await py.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'py-i1' }, [{ name: 'run-etl', kind: 'action' }]));

    const actionRows = await stack.runtime.handle.db
      .select({ name: actions.name })
      .from(actions)
      .where(eq(actions.workspaceId, ws.workspaceId));
    expect(actionRows.map((a) => a.name).sort()).toEqual(['run-etl']);
  });

  it('removes a provider through DELETE /v1/nodes/:node/providers/:name', async () => {
    const ws = await createWorkspace(stack.app, 'np-delete');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);

    const del = await stack.app.request('/v1/nodes/alpha/providers/py', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(del.status).toBe(204);
    const providers = await stack.runtime.handle.db
      .select({ name: nodeProviders.name })
      .from(nodeProviders)
      .where(and(eq(nodeProviders.workspaceId, ws.workspaceId), eq(nodeProviders.nodeId, 'node_a')));
    expect(providers).toHaveLength(0);
  });
});
