import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { actions, actionInvocations, agents, nodeProviders, nodes } from '../../db/schema.js';
import { NODE_LIVENESS_TTL_MS, PROVIDER_ATTACH_LIVENESS_MS } from '../../engine/placement.js';
import { drainNodeInvocations } from '../../index.js';
import { rescheduleInvocationsForLostNode, rescheduleNodeInvocation } from '../../engine/action.js';

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
    opts: { instanceId?: string; maxAgents?: number; load?: number | null } = {},
  ) {
    const provider = providerName ? { name: providerName, instance_id: opts.instanceId ?? `${providerName}-i1` } : undefined;
    const { sock, handle } = attachSocket(workspaceId, nodeId);
    await handle.handleMessage(registerFrame(nodeId, nodeName, provider, capabilities, opts.maxAgents));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      ...(provider ? { provider } : {}),
      ...(typeof opts.load === 'number' ? { load: opts.load, load_reported: true } : {}),
      active_agents: 0,
      handlers_live: true,
    }));
    return { sock, handle };
  }

  async function setupPrunedReleaseAction(slug: string, queue: boolean, prune = true) {
    const ws = await createWorkspace(stack.app, slug);
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    await enrollNode(ws, 'node_b', 'beta');
    const alpha = await attachProvider(
      ws.workspaceId,
      'node_a',
      'alpha',
      'fleet-a',
      [{ name: 'release', kind: 'action', ...(queue ? { queue: true } : {}) }],
    );
    const beta = await attachProvider(
      ws.workspaceId,
      'node_b',
      'beta',
      'fleet-b',
      [{ name: 'release', kind: 'action' }],
    );

    if (queue) {
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        load: 0,
        active_agents: 0,
        handlers_live: false,
      }));
    }

    alpha.sock.received.length = 0;
    beta.sock.received.length = 0;
    const invoked = await stack.app.request('/v1/nodes/alpha/actions/release/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { name: 'custom-target' } }),
    });
    expect(invoked.status).toBe(201);
    const invocationId = (await invoked.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(alpha.sock.ofType('action.invoke')).toHaveLength(queue ? 0 : 1);

    const [originalAction] = await stack.runtime.handle.db
      .select({ id: actions.id })
      .from(actions)
      .where(and(
        eq(actions.workspaceId, ws.workspaceId),
        eq(actions.handlerNodeId, 'node_a'),
        eq(actions.name, 'release'),
      ));
    expect(originalAction?.id).toBeTruthy();

    // The capability snapshot drops the exact action row. action_id is now
    // null, while immutable provenance must keep this invocation tied to the
    // deleted registration rather than the live same-name action on beta.
    if (prune) {
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        load: 0,
        active_agents: 0,
        handlers_live: !queue,
        capabilities: [],
      }));
      const [pruned] = await stack.runtime.handle.db
        .select({
          actionId: actionInvocations.actionId,
          invocationOrigin: actionInvocations.invocationOrigin,
          status: actionInvocations.status,
        })
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId));
      expect(pruned).toMatchObject({
        actionId: null,
        invocationOrigin: 'registered_action',
        status: queue ? 'pending' : 'dispatched',
      });
    }
    beta.sock.received.length = 0;

    return { ws, alpha, beta, invocationId, originalActionId: originalAction!.id };
  }

  async function expectDeletedActionFailure(invocationId: string) {
    const [invocation] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        invocationOrigin: actionInvocations.invocationOrigin,
        status: actionInvocations.status,
        error: actionInvocations.error,
        completedAt: actionInvocations.completedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toMatchObject({
      actionId: null,
      invocationOrigin: 'registered_action',
      status: 'failed',
      error: 'action_deleted',
    });
    expect(invocation.completedAt).toBeInstanceOf(Date);
  }

  async function expectAcceptedActionPreserved(invocationId: string) {
    const [invocation] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        invocationOrigin: actionInvocations.invocationOrigin,
        status: actionInvocations.status,
        error: actionInvocations.error,
        providerAcceptedAttempt: actionInvocations.providerAcceptedAttempt,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toMatchObject({
      actionId: null,
      invocationOrigin: 'registered_action',
      status: 'dispatched',
      error: null,
    });
    expect(invocation.providerAcceptedAttempt).toBe(invocation.dispatchAttempts);
  }

  it('keeps a mixed finite and unbounded provider aggregate unlimited with unreported load', async () => {
    const ws = await createWorkspace(stack.app, 'np-unbounded-load');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(
      ws.workspaceId,
      'node_a',
      'alpha',
      'finite',
      [{ name: 'run-etl', kind: 'action' }],
      { maxAgents: 4, load: 0.5 },
    );
    await attachProvider(
      ws.workspaceId,
      'node_a',
      'alpha',
      'unbounded',
      [{ name: 'spawn:codex', kind: 'capacity' }],
      { maxAgents: 0, load: 0 },
    );

    const [node] = await stack.runtime.handle.db
      .select({ maxAgents: nodes.maxAgents, load: nodes.load, loadReported: nodes.loadReported })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')));
    expect(node).toEqual({ maxAgents: 0, load: 0, loadReported: false });

    const roster = await stack.app.request('/v1/nodes?name=alpha', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const body = await roster.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ max_agents: 0, load: null });
  });

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

  it('logs a rejected node-control message server-side, not only on the socket', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ws = await createWorkspace(stack.app, 'np-reject-log');
      await enrollNode(ws, 'node_a', 'alpha');

      const first = attachSocket(ws.workspaceId, 'node_a');
      await first.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'i1' }, [{ name: 'run-etl', kind: 'action' }]));

      // A duplicate live instance is rejected. The rejection must surface
      // server-side too, so a half-registered node is not silent.
      const dup = attachSocket(ws.workspaceId, 'node_a');
      await dup.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'py', instance_id: 'i2' }, [{ name: 'run-etl', kind: 'action' }]));

      expect(dup.sock.ofType('error').at(-1)).toMatchObject({ code: 'provider_instance_conflict' });
      expect(warn).toHaveBeenCalledWith('[node.control] rejected message', expect.objectContaining({
        type: 'node.register',
        code: 'provider_instance_conflict',
        workspaceId: ws.workspaceId,
        nodeId: 'node_a',
      }));
    } finally {
      warn.mockRestore();
    }
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

  it('supersedes a stale provider binding when a fresh instance restarts after an unclean disconnect', async () => {
    // Spec §3.1: a restart (new instance_id) supersedes a stale binding. On an
    // UNCLEAN disconnect (kill -9 / dropped socket) the old connection is never
    // closed, so it lingers in the registry; the restart must still take over
    // once the old instance stops framing — not be blocked for the full node
    // TTL. Drive Date.now so the incumbent's last frame ages past the attach
    // window but remains within the node-liveness TTL.
    let nowMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const ws = await createWorkspace(stack.app, 'np-stale-supersede');
      await enrollNode(ws, 'node_a', 'alpha');

      const first = attachSocket(ws.workspaceId, 'node_a');
      await first.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'broker', instance_id: 'epoch-1' }, [{ name: 'spawn:claude', kind: 'capacity' }]));
      expect(first.sock.ofType('reply').at(-1)).toMatchObject({ ok: true });

      // Unclean disconnect: no handleClose. The attach window must remain
      // strictly below the node TTL for this takeover path to exist.
      expect(PROVIDER_ATTACH_LIVENESS_MS).toBeLessThan(NODE_LIVENESS_TTL_MS);
      nowMs += PROVIDER_ATTACH_LIVENESS_MS + 1;

      const restart = attachSocket(ws.workspaceId, 'node_a');
      await restart.handle.handleMessage(registerFrame('node_a', 'alpha', { name: 'broker', instance_id: 'epoch-2' }, [{ name: 'spawn:claude', kind: 'capacity' }]));

      expect(restart.sock.ofType('error')).toHaveLength(0);
      expect(restart.sock.ofType('reply').at(-1)).toMatchObject({ ok: true });
      expect(first.sock.closed).toBe(true);
      const [row] = await stack.runtime.handle.db
        .select({ caps: nodes.capabilities })
        .from(nodes)
        .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')));
      expect((row?.caps ?? []).map((c) => c.name)).toEqual(['spawn:claude']);
      const [provider] = await stack.runtime.handle.db
        .select({ instanceId: nodeProviders.instanceId })
        .from(nodeProviders)
        .where(and(
          eq(nodeProviders.workspaceId, ws.workspaceId),
          eq(nodeProviders.nodeId, 'node_a'),
          eq(nodeProviders.name, 'broker'),
        ));
      expect(provider?.instanceId).toBe('epoch-2');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('still rejects a direct SDK instance through the attach-liveness boundary', async () => {
    let nowMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      const ws = await createWorkspace(stack.app, 'np-live-dup');
      await enrollNode(ws, 'node_a', 'alpha');

      const first = attachSocket(ws.workspaceId, 'node_a');
      await first.handle.handleMessage(registerFrame('node_a', 'alpha', undefined, []));
      expect(first.sock.ofType('reply').at(-1)).toMatchObject({ ok: true });

      // Direct node connections in the built-in SDKs heartbeat every 30s. The
      // attach window includes scheduling slack and remains live at its exact
      // inclusive boundary.
      expect(PROVIDER_ATTACH_LIVENESS_MS).toBeGreaterThan(30_000);
      nowMs += PROVIDER_ATTACH_LIVENESS_MS;
      const dup = attachSocket(ws.workspaceId, 'node_a');
      await dup.handle.handleMessage(registerFrame('node_a', 'alpha', undefined, []));
      expect(dup.sock.ofType('error').at(-1)).toMatchObject({ code: 'provider_instance_conflict' });
    } finally {
      nowSpy.mockRestore();
    }
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

  it('rejects native spawn without a non-empty agent name before reserving capacity', async () => {
    const ws = await createWorkspace(stack.app, 'np-spawn-name-required');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    const broker = await attachProvider(
      ws.workspaceId,
      'node_a',
      'alpha',
      'default',
      [{ name: 'spawn:claude', kind: 'capacity' }],
      { maxAgents: 1 },
    );

    const response = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude' } }),
    });

    expect(response.status).toBe(400);
    expect(broker.sock.ofType('action.invoke')).toHaveLength(0);
    expect(await stack.runtime.handle.db
      .select()
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'spawn'),
      )))
      .toHaveLength(0);
    const [node] = await stack.runtime.handle.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')));
    expect(node.reservedAgents).toBe(0);
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

  it('drains a guarded release back to the named provider that owns its generation', async () => {
    const ws = await createWorkspace(stack.app, 'np-release-drain-owner');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', []);
    await py.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-release-drain-worker',
      type: 'agent.register',
      name: 'release-drain-worker',
      session_ref: 'pty://py/release-drain-worker',
    }));
    const [worker] = await stack.runtime.handle.db
      .select({ id: agents.id, name: agents.name, tokenHash: agents.tokenHash })
      .from(agents)
      .where(and(
        eq(agents.workspaceId, ws.workspaceId),
        eq(agents.name, 'release-drain-worker'),
      ));
    expect(worker).toBeTruthy();

    await stack.runtime.handle.db.insert(actionInvocations).values({
      id: 'inv_named_provider_release_drain',
      workspaceId: ws.workspaceId,
      actionName: 'release',
      invocationOrigin: 'builtin',
      callerName: 'workspace',
      handlerNodeId: 'node_a',
      input: {
        name: worker.name,
        delete_agent: true,
        expected_token_hash: worker.tokenHash,
      },
      status: 'pending',
      dispatchedNodeId: 'node_a',
      dispatchedProvider: 'py',
      attemptedNodeIds: ['node_a'],
      dispatchAttempts: 1,
    });

    py.sock.received.length = 0;
    const drained = await drainNodeInvocations(
      stack.runtime.handle.db,
      stack.runtime.realtime,
      ws.workspaceId,
      'node_a',
    );

    expect(drained).toBe(1);
    expect(py.sock.ofType('action.invoke')).toEqual([
      expect.objectContaining({
        invocation_id: 'inv_named_provider_release_drain',
        action: 'release',
        input: expect.objectContaining({ expected_token_hash: worker.tokenHash }),
      }),
    ]);
    const [invocation] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, provider: actionInvocations.dispatchedProvider })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, 'inv_named_provider_release_drain'));
    expect(invocation).toEqual({ status: 'dispatched', provider: 'py' });
  });

  it('preserves an accepted pruned action instead of retrying it onto a same-name replacement', async () => {
    const { ws, beta, invocationId } = await setupPrunedReleaseAction(
      'np-pruned-action-retry',
      false,
    );

    const rescheduled = await rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      stack.runtime.realtime,
      ws.workspaceId,
      'node_a',
    );

    expect(rescheduled).toBe(0);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(0);
    await expectAcceptedActionPreserved(invocationId);
  });

  it('preserves the prior accepted generation when a replacement prunes before authorization', async () => {
    const { ws, beta, invocationId, originalActionId } = await setupPrunedReleaseAction(
      'np-concurrent-pruned-action-retry',
      false,
      false,
    );
    const registry = stack.runtime.realtime;
    const originalConnected = registry.isProviderConnected.bind(registry);
    let pruned = false;
    vi.spyOn(registry, 'isProviderConnected').mockImplementation((workspaceId, nodeId, providerName) => {
      if (!pruned && nodeId === 'node_b') {
        pruned = true;
        stack.runtime.handle.sqlite
          .prepare('DELETE FROM actions WHERE workspace_id = ? AND id = ?')
          .run(ws.workspaceId, originalActionId);
      }
      return originalConnected(workspaceId, nodeId, providerName);
    });

    const rescheduled = await rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      registry,
      ws.workspaceId,
      'node_a',
    );

    expect(pruned).toBe(true);
    expect(rescheduled).toBe(0);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(0);
    await expectAcceptedActionPreserved(invocationId);
  });

  it('does not fail a concurrent registered-action handoff winner', async () => {
    const { ws, beta, invocationId, originalActionId } = await setupPrunedReleaseAction(
      'np-concurrent-action-handoff-winner',
      false,
      false,
    );
    const db = stack.runtime.handle.db;
    const [retrySnapshot] = await db
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    const [replacement] = await db
      .select({ id: actions.id })
      .from(actions)
      .where(and(
        eq(actions.workspaceId, ws.workspaceId),
        eq(actions.handlerNodeId, 'node_b'),
        eq(actions.name, 'release'),
      ));
    expect(retrySnapshot.actionId).toBe(originalActionId);
    expect(replacement?.id).toBeTruthy();

    // A competing retry wins the exact source→replacement CAS first.
    stack.runtime.handle.sqlite.prepare(`
      UPDATE action_invocations
      SET action_id = ?, dispatched_node_id = 'node_b', dispatched_provider = 'fleet-b'
      WHERE id = ?
    `).run(replacement!.id, invocationId);
    beta.sock.received.length = 0;

    const rescheduled = await rescheduleNodeInvocation(db, stack.runtime.realtime, retrySnapshot);

    expect(rescheduled).toBe(false);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(0);
    const [winner] = await db
      .select({
        actionId: actionInvocations.actionId,
        status: actionInvocations.status,
        error: actionInvocations.error,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(winner).toEqual({
      actionId: replacement!.id,
      status: 'dispatched',
      error: null,
      dispatchedNodeId: 'node_b',
    });
  });

  it('claims the retry route before send so a second lost-node rescheduler cannot duplicate it', async () => {
    const { ws, beta, invocationId } = await setupPrunedReleaseAction(
      'np-concurrent-action-route-claim',
      false,
      false,
    );
    const registry = stack.runtime.realtime;
    const originalSend = registry.sendAuthorizedActionToProvider!.bind(registry);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let pauseFirst = true;
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (
      workspaceId,
      nodeId,
      providerName,
      message,
      authorization,
    ) => {
      if (pauseFirst && nodeId === 'node_b' && message.type === 'action.invoke') {
        pauseFirst = false;
        markFirstStarted();
        await firstRelease;
      }
      return originalSend(workspaceId, nodeId, providerName, message, authorization);
    });

    const firstRetry = rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      registry,
      ws.workspaceId,
      'node_a',
    );
    await firstStarted;
    const secondRetry = await rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      registry,
      ws.workspaceId,
      'node_a',
    );
    releaseFirst();

    expect(await firstRetry).toBe(1);
    expect(secondRetry).toBe(0);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(1);
    const [invocation] = await stack.runtime.handle.db
      .select({
        status: actionInvocations.status,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(invocation).toEqual({
      status: 'dispatched',
      dispatchedNodeId: 'node_b',
      dispatchAttempts: 2,
    });
  });

  it('does not let a stale failed send terminalize a newer registered-action attempt', async () => {
    const { ws, invocationId } = await setupPrunedReleaseAction(
      'np-stale-action-send-failure',
      false,
      false,
    );
    const registry = stack.runtime.realtime;
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const sendRelease = new Promise<void>((resolve) => { releaseSend = resolve; });
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (
      _workspaceId,
      nodeId,
      _providerName,
      message,
    ) => {
      if (nodeId === 'node_b' && message.type === 'action.invoke') {
        markSendStarted();
        await sendRelease;
        return false;
      }
      return false;
    });

    const staleRetry = rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      registry,
      ws.workspaceId,
      'node_a',
    );
    await sendStarted;
    const [claimed] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({
        status: 'dispatched',
        error: null,
        dispatchedNodeId: 'node_b',
        dispatchedProvider: 'fleet-b',
        dispatchAttempts: claimed.dispatchAttempts + 1,
      })
      .where(eq(actionInvocations.id, invocationId));
    releaseSend();

    expect(await staleRetry).toBe(0);
    const [winner] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        status: actionInvocations.status,
        error: actionInvocations.error,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        dispatchedProvider: actionInvocations.dispatchedProvider,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(winner).toEqual({
      actionId: claimed.actionId,
      status: 'dispatched',
      error: null,
      dispatchedNodeId: 'node_b',
      dispatchedProvider: 'fleet-b',
      dispatchAttempts: claimed.dispatchAttempts + 1,
    });
  });

  it('preserves an accepted registered-action attempt when its capability is pruned afterward', async () => {
    const { ws, beta, invocationId } = await setupPrunedReleaseAction(
      'np-accepted-action-prune',
      false,
      false,
    );
    const registry = stack.runtime.realtime;
    const [staleRetrySnapshot] = await stack.runtime.handle.db
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    const originalSend = registry.sendAuthorizedActionToProvider!.bind(registry);
    let releaseAccepted!: () => void;
    let markAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    const acceptedRelease = new Promise<void>((resolve) => { releaseAccepted = resolve; });
    let pauseFirst = true;
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (
      workspaceId,
      nodeId,
      providerName,
      message,
      authorization,
    ) => {
      const sent = await originalSend(workspaceId, nodeId, providerName, message, authorization);
      if (pauseFirst && nodeId === 'node_b' && message.type === 'action.invoke') {
        pauseFirst = false;
        markAccepted();
        await acceptedRelease;
      }
      return sent;
    });

    const retry = rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      registry,
      ws.workspaceId,
      'node_a',
    );
    await accepted;
    const [claimed] = await stack.runtime.handle.db
      .select({ actionId: actionInvocations.actionId })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    await stack.runtime.handle.db
      .delete(actions)
      .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.id, claimed.actionId!)));
    expect(await rescheduleNodeInvocation(
      stack.runtime.handle.db,
      registry,
      staleRetrySnapshot,
    )).toBe(false);
    const [stillAccepted] = await stack.runtime.handle.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        providerAcceptedAttempt: actionInvocations.providerAcceptedAttempt,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(stillAccepted).toEqual({
      status: 'dispatched',
      error: null,
      providerAcceptedAttempt: expect.any(Number),
      dispatchAttempts: expect.any(Number),
    });
    expect(stillAccepted.providerAcceptedAttempt).toBe(stillAccepted.dispatchAttempts);
    releaseAccepted();

    expect(await retry).toBe(1);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(1);
    await beta.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: invocationId,
      output: { accepted: true },
    }));
    const [completed] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        status: actionInvocations.status,
        error: actionInvocations.error,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        dispatchedProvider: actionInvocations.dispatchedProvider,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(completed).toEqual({
      actionId: null,
      status: 'completed',
      error: null,
      dispatchedNodeId: 'node_b',
      dispatchedProvider: 'fleet-b',
    });
  });

  it('does not deliver a claimed action after pruning replaces its exact identity', async () => {
    const { ws, beta, invocationId } = await setupPrunedReleaseAction(
      'np-prune-before-action-authorization',
      false,
      false,
    );
    const registry = stack.runtime.realtime;
    const originalSend = registry.sendAuthorizedActionToProvider!.bind(registry);
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const sendRelease = new Promise<void>((resolve) => { releaseSend = resolve; });
    let pauseFirst = true;
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      if (
        pauseFirst
        && args[1] === 'node_b'
        && args[3].type === 'action.invoke'
        && args[4].kind === 'registered-node-action-v1'
      ) {
        pauseFirst = false;
        markSendStarted();
        await sendRelease;
      }
      return originalSend(...args);
    });

    const retry = rescheduleInvocationsForLostNode(
      stack.runtime.handle.db,
      registry,
      ws.workspaceId,
      'node_a',
    );
    await sendStarted;
    const [claimed] = await stack.runtime.handle.db
      .select({ actionId: actionInvocations.actionId })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    await stack.runtime.handle.db
      .delete(actions)
      .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.id, claimed.actionId!)));
    await beta.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      load: 0,
      active_agents: 0,
      handlers_live: true,
      capabilities: [{ name: 'release', kind: 'action' }],
    }));
    const [replacement] = await stack.runtime.handle.db
      .select({ id: actions.id })
      .from(actions)
      .where(and(
        eq(actions.workspaceId, ws.workspaceId),
        eq(actions.handlerNodeId, 'node_b'),
        eq(actions.name, 'release'),
      ));
    expect(replacement.id).not.toBe(claimed.actionId);
    releaseSend();

    expect(await retry).toBe(0);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(0);
    await expectDeletedActionFailure(invocationId);
  });

  it('reports a pre-authorization action prune consistently to the request and replay', async () => {
    const ws = await createWorkspace(stack.app, 'np-action-prune-request-outcome');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', undefined, [{ name: 'prune-before-auth', kind: 'action' }]);
    const registry = stack.runtime.realtime;
    const originalSend = registry.sendAuthorizedActionToProvider!.bind(registry);
    let releaseAuthorization!: () => void;
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => { markAuthorizationStarted = resolve; });
    const authorizationRelease = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let pauseFirst = true;
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      if (pauseFirst && args[3].action === 'prune-before-auth') {
        pauseFirst = false;
        markAuthorizationStarted();
        await authorizationRelease;
      }
      return originalSend(...args);
    });

    const invoke = () => stack.app.request('/v1/actions/prune-before-auth/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': 'prune-before-auth-request',
      },
      body: JSON.stringify({ input: { work: true } }),
    });
    const firstPromise = invoke();
    await authorizationStarted;
    await stack.runtime.handle.db
      .delete(actions)
      .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.name, 'prune-before-auth')));
    releaseAuthorization();

    const first = await firstPromise;
    const replay = await invoke();
    expect([first.status, replay.status]).toEqual([503, 503]);
    await expect(first.json()).resolves.toMatchObject({ error: { code: 'action_deleted' } });
    await expect(replay.json()).resolves.toMatchObject({ error: { code: 'action_deleted' } });
  });

  it('fails a queued pruned registered action during drain without dispatching it by name', async () => {
    const { ws, alpha, beta, invocationId } = await setupPrunedReleaseAction(
      'np-pruned-action-drain',
      true,
    );

    const drained = await drainNodeInvocations(
      stack.runtime.handle.db,
      stack.runtime.realtime,
      ws.workspaceId,
      'node_a',
      { includeDeferred: true },
    );

    expect(drained).toBe(0);
    expect(alpha.sock.ofType('action.invoke')).toHaveLength(0);
    expect(beta.sock.ofType('action.invoke')).toHaveLength(0);
    await expectDeletedActionFailure(invocationId);
  });

  it('preserves an accepted pruned action during inventory reconciliation', async () => {
    const { alpha, beta, invocationId } = await setupPrunedReleaseAction(
      'np-pruned-action-reconcile',
      false,
    );

    await alpha.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-after-action-prune',
      type: 'inventory.sync',
      agents: [],
    }));

    expect(alpha.sock.ofType('reply').find(
      (frame) => frame.id === 'inventory-after-action-prune',
    )).toMatchObject({ ok: true, data: { rescheduled_invocations: 0 } });
    expect(beta.sock.ofType('action.invoke')).toHaveLength(0);
    await expectAcceptedActionPreserved(invocationId);
  });

  it('keeps one provider inventory from offlining agents or rescheduling invocations owned by another', async () => {
    const ws = await createWorkspace(stack.app, 'np-inventory-isolation');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);

    await py.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-py-worker',
      type: 'agent.register',
      name: 'py-worker',
      session_ref: 'pty://py/worker',
    }));
    await rb.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-rb-worker',
      type: 'agent.register',
      name: 'rb-worker',
      session_ref: 'pty://rb/worker',
    }));
    const pyAgentId = (py.sock.ofType('reply').find((frame) => frame.id === 'register-py-worker') as {
      data: { agent_id: string };
    }).data.agent_id;

    const invoke = await stack.app.request('/v1/nodes/alpha/actions/build/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { task: 'keep with rb' } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(rb.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId });

    await py.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'py-inventory-only',
      type: 'inventory.sync',
      agents: [{ agent_id: pyAgentId, name: 'py-worker', session_ref: 'pty://py/worker' }],
    }));
    expect(py.sock.ofType('reply').find((frame) => frame.id === 'py-inventory-only')).toMatchObject({ ok: true });

    const rbAgent = await stack.runtime.handle.db
      .select({ status: agents.status, providerName: agents.providerName })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, 'rb-worker')))
      .then((rows) => rows[0]);
    expect(rbAgent).toEqual({ status: 'active', providerName: 'rb' });

    const invocation = await stack.runtime.handle.db
      .select({
        status: actionInvocations.status,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        dispatchedProvider: actionInvocations.dispatchedProvider,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId))
      .then((rows) => rows[0]);
    expect(invocation).toEqual({
      status: 'dispatched',
      dispatchedNodeId: 'node_a',
      dispatchedProvider: 'rb',
    });
  });

  it('rejects cross-provider action results and delivery acknowledgements', async () => {
    const ws = await createWorkspace(stack.app, 'np-frame-isolation');
    const poster = await registerAgent(stack.app, ws.workspaceKey, 'poster');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);

    await rb.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-rb-ack-worker',
      type: 'agent.register',
      name: 'rb-ack-worker',
      session_ref: 'pty://rb/ack-worker',
    }));

    const invoke = await stack.app.request('/v1/nodes/alpha/actions/build/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${poster.token}` },
      body: JSON.stringify({ input: { task: 'provider-owned' } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;

    await py.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: invocationId,
      output: { provider: 'wrong' },
    }));
    const statusAfterWrongProvider = await stack.runtime.handle.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId))
      .then((rows) => rows[0]?.status);
    expect(statusAfterWrongProvider).toBe('dispatched');

    await rb.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: invocationId,
      output: { provider: 'rb' },
    }));
    const statusAfterOwner = await stack.runtime.handle.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId))
      .then((rows) => rows[0]?.status);
    expect(statusAfterOwner).toBe('completed');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${poster.token}` },
      body: JSON.stringify({ text: 'provider-scoped ack' }),
    });
    expect(post.status).toBe(201);
    for (let i = 0; i < 50 && deliverFramesOfType(rb.sock, 'message.created').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const delivery = deliverFramesOfType(rb.sock, 'message.created').at(-1) as { seq?: number } | undefined;
    expect(delivery?.seq).toBeGreaterThan(0);
    const upToSeq = delivery?.seq ?? 0;

    await py.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'rb-ack-worker',
      up_to_seq: upToSeq,
    }));
    const cursorAfterWrongProvider = await stack.runtime.handle.db
      .select({ deliveryAckSeq: agents.deliveryAckSeq })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, 'rb-ack-worker')))
      .then((rows) => rows[0]?.deliveryAckSeq);
    expect(cursorAfterWrongProvider).toBe(0);

    await rb.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'rb-ack-worker',
      up_to_seq: upToSeq,
    }));
    const cursorAfterOwner = await stack.runtime.handle.db
      .select({ deliveryAckSeq: agents.deliveryAckSeq })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.name, 'rb-ack-worker')))
      .then((rows) => rows[0]?.deliveryAckSeq);
    expect(cursorAfterOwner).toBe(upToSeq);
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

  it('returns the agent-hosted action when a local node fallback has the same name', async () => {
    const ws = await createWorkspace(stack.app, 'np-action-detail-precedence');
    await enrollNode(ws, 'node_a', 'alpha');
    await attachProvider(ws.workspaceId, 'node_a', 'alpha', undefined, [{ name: 'resolve-me', kind: 'action' }]);
    const helper = await registerAgent(stack.app, ws.workspaceKey, 'detail-helper');
    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${helper.token}` },
      body: JSON.stringify({ name: 'resolve-me', description: 'agent wins', handler_agent: helper.name }),
    });
    expect(register.status).toBe(201);

    const response = await stack.app.request('/v1/actions/resolve-me', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { handler_agent: string | null; handler_node: string | null } }).data)
      .toMatchObject({ handler_agent: helper.name, handler_node: null });
  });

  it('routes context.update to the provider hosting the agent, not a phantom node default', async () => {
    const ws = await createWorkspace(stack.app, 'np-context');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await enrollNode(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    const rb = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'rb', [{ name: 'build', kind: 'action' }]);
    // The recipient `worker` is hosted by py; rb hosts no agents.
    await py.handle.handleMessage(JSON.stringify({ v: 1, id: 'agent-1', type: 'agent.register', name: 'worker', session_ref: 'pty://py/worker' }));
    const workerId = (py.sock.ofType('reply').at(-1) as { data?: { agent_id?: string } }).data?.agent_id;
    expect(workerId).toBeTruthy();

    py.sock.received.length = 0;
    rb.sock.received.length = 0;
    // A presence change on alice (the subject) fans context out to the agents
    // that host it — worker on py — and never to rb, which hosts none.
    await stack.runtime.presence.heartbeat(ws.workspaceId, alice.agentId, 'alice');
    for (let i = 0; i < 50 && contextUpdatesOfType(py.sock, 'agent.status.active').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const pyUpdates = contextUpdatesOfType(py.sock, 'agent.status.active');
    expect(pyUpdates.length).toBeGreaterThanOrEqual(1);
    expect(pyUpdates[0].agent_ids).toContain(workerId);
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

  it('routes a node.spawn frame to the connection\'s own node capacity, bypassing any spawn shadow', async () => {
    const ws = await createWorkspace(stack.app, 'np-node-spawn');
    await enrollNode(ws, 'node_a', 'alpha');
    // node_a: broker provider offers native spawn:claude capacity.
    const broker = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);
    // A policy provider shadows it with a spawn:claude action, and is where the
    // handler runs: its ctx.spawnAgent must delegate to broker capacity, never
    // re-enter its own shadow.
    const policy = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'policy', [{ name: 'spawn:claude', kind: 'action' }]);
    // A second node with its own spawn capacity: a node.spawn from node_a must
    // never reach it — a node credential cannot direct a spawn at another node.
    await enrollNode(ws, 'node_b', 'beta');
    const otherBroker = await attachProvider(ws.workspaceId, 'node_b', 'beta', 'default', [{ name: 'spawn:claude', kind: 'capacity' }]);

    await policy.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'spawn-1',
      type: 'node.spawn',
      input: { cli: 'claude', name: 'worker-1' },
    }));

    // Delegated to node_a's broker capacity...
    expect(broker.sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'spawn:claude' });
    // ...not back into the policy provider's shadow action...
    expect(policy.sock.ofType('action.invoke')).toHaveLength(0);
    // ...and never crossing to the other node.
    expect(otherBroker.sock.ofType('action.invoke')).toHaveLength(0);
    const reply = policy.sock.ofType('reply').at(-1) as { ok?: boolean; id?: string; data?: { invocation_id?: string; handler_node_id?: string } };
    expect(reply).toMatchObject({ ok: true, id: 'spawn-1' });
    expect(typeof reply.data?.invocation_id).toBe('string');
    expect(reply.data?.handler_node_id).toBe('node_a');
  });

  it('keeps shadow-spawn capacity owned by the delegated native invocation', async () => {
    const ws = await createWorkspace(stack.app, 'np-shadow-delegated-reservation');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await enrollNode(ws, 'node_a', 'alpha');
    const broker = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'default', [
      { name: 'spawn:claude', kind: 'capacity' },
      { name: 'spawn:codex', kind: 'capacity' },
    ], { maxAgents: 2 });
    const policy = await attachProvider(
      ws.workspaceId,
      'node_a',
      'alpha',
      'policy',
      [{ name: 'spawn:claude', kind: 'action' }],
      { maxAgents: 0 },
    );
    await stack.runtime.handle.db
      .update(nodes)
      .set({ maxAgents: 2 })
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')));

    const codexResponse = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'codex', name: 'codex-reserved' } }),
    });
    expect(codexResponse.status).toBe(201);
    const codexInvocationId = (await codexResponse.json() as { data: { invocation_id: string } }).data.invocation_id;

    const shadowResponse = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude', name: 'shadow-outer' } }),
    });
    expect(shadowResponse.status).toBe(201);
    const shadowInvocationId = (await shadowResponse.json() as { data: { invocation_id: string } }).data.invocation_id;

    await policy.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'delegate-shadow-spawn',
      type: 'node.spawn',
      input: { cli: 'claude', name: 'shadow-delegated' },
    }));
    const delegatedReply = policy.sock.ofType('reply').at(-1) as {
      ok?: boolean;
      data?: { invocation_id?: string };
    };
    expect(delegatedReply).toMatchObject({ ok: true, id: 'delegate-shadow-spawn' });
    const delegatedInvocationId = delegatedReply.data?.invocation_id;
    expect(delegatedInvocationId).toBeTruthy();

    const [reserved] = await stack.runtime.handle.db
      .select({ value: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, 'node_a')));
    expect(reserved.value).toBe(2);

    await policy.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-with-shadow-outer',
      type: 'agent.register',
      name: 'shadow-outer',
      invocation_id: shadowInvocationId,
    }));
    expect(policy.sock.ofType('error').at(-1)).toMatchObject({
      id: 'register-with-shadow-outer',
      code: 'node_capacity_exceeded',
    });

    await broker.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-delegated-shadow',
      type: 'agent.register',
      name: 'shadow-delegated',
      invocation_id: delegatedInvocationId,
    }));
    expect(broker.sock.ofType('reply').at(-1)).toMatchObject({ id: 'register-delegated-shadow', ok: true });
    await broker.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-native-codex',
      type: 'agent.register',
      name: 'codex-reserved',
      invocation_id: codexInvocationId,
    }));
    expect(broker.sock.ofType('reply').at(-1)).toMatchObject({ id: 'register-native-codex', ok: true });
  });

  // ctx.sendMessage posts through the canonical message route with a node token
  // and a required `from`, so node-attributed posts get delivery routing,
  // observer events, and triggers by construction (no parallel posting path).
  async function enrollNodeWithToken(ws: { workspaceKey: string }, nodeId: string, name: string): Promise<string> {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name, role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
    return (await res.json() as { data: { token: string } }).data.token;
  }

  function postMessage(token: string, channel: string, body: Record<string, unknown>) {
    return stack.app.request(`/v1/channels/${channel}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it('posts a node-token message attributed to `from`, delivered to node-hosted recipients', async () => {
    const ws = await createWorkspace(stack.app, 'nt-msg');
    await registerAgent(stack.app, ws.workspaceKey, 'poster');
    const nodeToken = await enrollNodeWithToken(ws, 'node_a', 'alpha');
    const py = await attachProvider(ws.workspaceId, 'node_a', 'alpha', 'py', [{ name: 'run-etl', kind: 'action' }]);
    // A worker agent hosted by py joins #general, so it is a delivery recipient.
    await py.handle.handleMessage(JSON.stringify({ v: 1, id: 'agent-1', type: 'agent.register', name: 'worker', session_ref: 'pty://py/worker' }));
    py.sock.received.length = 0;

    const res = await postMessage(nodeToken, 'general', { text: 'etl finished', from: 'poster' });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { agent_name: string; text: string } };
    expect(body.data).toMatchObject({ agent_name: 'poster', text: 'etl finished' });

    // Poll for the async fanout instead of a fixed sleep, to avoid CI flakiness.
    for (let i = 0; i < 50 && deliverFramesOfType(py.sock, 'message.created').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Delivery routing came for free from the canonical route.
    expect(deliverFramesOfType(py.sock, 'message.created').length).toBeGreaterThanOrEqual(1);
  });

  it('requires `from` on a node-token message', async () => {
    const ws = await createWorkspace(stack.app, 'nt-msg-from-required');
    const nodeToken = await enrollNodeWithToken(ws, 'node_a', 'alpha');
    const res = await postMessage(nodeToken, 'general', { text: 'hi' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('from_required');
  });

  it('rejects a node-token message whose `from` agent does not exist', async () => {
    const ws = await createWorkspace(stack.app, 'nt-msg-unknown');
    const nodeToken = await enrollNodeWithToken(ws, 'node_a', 'alpha');
    const res = await postMessage(nodeToken, 'general', { text: 'hi', from: 'ghost' });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('agent_not_found');
  });

  it('scopes node-token `from` to the node workspace, rejecting a cross-workspace agent', async () => {
    const other = await createWorkspace(stack.app, 'nt-msg-other-ws');
    await registerAgent(stack.app, other.workspaceKey, 'outsider');

    const ws = await createWorkspace(stack.app, 'nt-msg-scope');
    const nodeToken = await enrollNodeWithToken(ws, 'node_a', 'alpha');
    const res = await postMessage(nodeToken, 'general', { text: 'hi', from: 'outsider' });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('agent_not_found');
  });

  it('rejects `from` on an agent-token message', async () => {
    const ws = await createWorkspace(stack.app, 'nt-msg-agent-from');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'poster');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'other');
    const res = await postMessage(agent.token, 'general', { text: 'hi', from: other.name });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('from_not_allowed');
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
