import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, injectUpdateFailure, type TestStack } from './harness.js';
import { actionInvocations, agents, nodes } from '../../db/schema.js';
import { sweepTimedOutInvocations } from '../../engine/action.js';
import { sweepOfflineNodes } from '../../engine/node.js';
import { recordNodeFrameRefused } from '../../node-control.js';
import {
  INVOCATION_EVENT_LIMIT,
  explainInvocation,
  invocationEvent,
  recordInvocationEvent,
} from '../../engine/invocationEvents.js';

type Invocation = {
  status: string;
  output: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  explanation: string;
  registered_agent: { agent_id: string; name: string; node_id: string | null } | null;
};

/**
 * A spawn reports what actually happened to it: every dispatch, agent
 * registration, accepted or rejected result and requeue (with its reason) is
 * on the invocation's timeline, and the GET explains it in one sentence.
 */
describe('spawn invocation timeline', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function attachNode(ws: { workspaceKey: string; workspaceId: string }, id: string, name: string) {
    const create = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: id, name, capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'test' }),
    });
    expect(create.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    const register = () => handle.handleMessage(JSON.stringify({
      v: 1, id: `register-${id}`, type: 'node.register', name, node_id: id,
      capabilities: [{ name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } }],
      max_agents: 4, tags: ['test'], version: 'test', resume_cursor: null,
    }));
    await register();
    return { sock, handle, register };
  }

  async function spawn(token: string, name: string): Promise<string> {
    const res = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: { cli: 'claude', name, task: 'say hi' } }),
    });
    expect(res.status).toBe(201);
    return (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
  }

  async function getInvocation(token: string, invocationId: string): Promise<Invocation> {
    const res = await stack.app.request(`/v1/actions/spawn/invocations/${invocationId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json() as { data: Invocation }).data;
  }

  function registerSpawnedAgent(node: { handle: { handleMessage(raw: string): Promise<unknown> } }, name: string, invocationId: string) {
    return node.handle.handleMessage(JSON.stringify({
      v: 1, id: `agent-${name}`, type: 'agent.register', name, invocation_id: invocationId,
      session_ref: `pty://${name}`, resumable: false,
    }));
  }

  function makeHeartbeatStale(nodeId: string) {
    return stack.runtime.handle.db
      .update(nodes)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(nodes.id, nodeId));
  }

  const types = (invocation: Invocation) => invocation.events.map((event) => event.type);

  it('records a successful spawn as dispatched, then registered, then result ok', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-ok');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-ok');
    expect(alpha.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId });

    const dispatched = await getInvocation(caller.token, invocationId);
    expect(types(dispatched)).toEqual(['created', 'placed', 'dispatched']);
    expect(dispatched.events[2]).toMatchObject({ node_id: 'node_alpha', attempt: 1 });
    expect(dispatched.explanation).toMatch(/^Dispatched to node alpha at .* \(attempt 1\); waiting for the node to report a result\.$/);

    await registerSpawnedAgent(alpha, 'worker-ok', invocationId);
    const registered = await getInvocation(caller.token, invocationId);
    expect(registered.registered_agent).toMatchObject({ name: 'worker-ok', node_id: 'node_alpha' });
    expect(registered.explanation).toMatch(/^Node alpha launched agent worker-ok \(registered .* UTC\); waiting for the node to report its result\.$/);

    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-ok' },
    }));
    const completed = await getInvocation(caller.token, invocationId);
    expect(completed.status).toBe('completed');
    expect(types(completed)).toEqual(['created', 'placed', 'dispatched', 'agent_registered', 'result_received', 'completed']);
    expect(completed.events[4]).toMatchObject({ node_id: 'node_alpha', ok: true });
    expect(completed.explanation).toMatch(/^Node alpha launched agent worker-ok \(registered .* UTC\) and it reported success at .* UTC\.$/);
    expect(alpha.sock.ofType('error').filter((frame) => String(frame.code).startsWith('action_result_'))).toHaveLength(0);
  });

  it('records a requeue after a stale heartbeat with its reason and applies the late result from that node', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-stale');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-late');

    await makeHeartbeatStale('node_alpha');
    expect(await sweepOfflineNodes(stack.runtime.handle.db, stack.runtime.realtime)).toBe(1);

    const requeued = await getInvocation(caller.token, invocationId);
    expect(requeued.status).toBe('pending');
    expect(requeued.events.at(-1)).toMatchObject({
      type: 'requeued',
      node_id: 'node_alpha',
      reason: 'node_lost',
      detail: 'liveness_timeout',
    });
    expect(requeued.explanation).toMatch(
      /^Requeued at .* UTC after the node's heartbeat went stale; waiting to be dispatched again/,
    );

    // The node was only briefly unreachable: it comes back, the agent it was
    // launching registers, and its result arrives after the requeue.
    await alpha.register();
    await registerSpawnedAgent(alpha, 'worker-late', invocationId);
    const launched = await getInvocation(caller.token, invocationId);
    expect(launched.registered_agent).toMatchObject({ name: 'worker-late' });
    expect(launched.explanation).toMatch(
      /^Node alpha launched agent worker-late \(registered .* UTC\), but the invocation was requeued at .* UTC after the node's heartbeat went stale and no result has been accepted since\.$/,
    );

    // Another provider connection on the same node did not receive the work,
    // so its result is not applied.
    const impostor = new FakeSocket();
    const impostorHandle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_alpha', impostor);
    await impostorHandle.handleMessage(JSON.stringify({
      v: 1, id: 'register-impostor', type: 'node.register', name: 'alpha', node_id: 'node_alpha',
      provider: { name: 'impostor', instance_id: 'impostor-1' },
      capabilities: [], max_agents: 4, tags: ['test'], version: 'test', resume_cursor: null,
    }));
    await impostorHandle.handleMessage(JSON.stringify({
      v: 1, id: 'impostor-result', type: 'action.result', invocation_id: invocationId, output: { forged: true },
    }));
    expect(impostor.ofType('error').at(-1)).toMatchObject({ id: 'impostor-result', code: 'action_result_not_dispatched' });
    expect((await getInvocation(caller.token, invocationId)).status).toBe('pending');

    alpha.sock.received.length = 0;
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-late' },
    }));
    const completed = await getInvocation(caller.token, invocationId);
    expect(completed.status).toBe('completed');
    expect(completed.output).toEqual({ agent: 'worker-late' });
    expect(types(completed)).toEqual([
      'created', 'placed', 'dispatched', 'requeued', 'agent_registered', 'result_rejected', 'result_received', 'completed',
    ]);
    expect(completed.events[3]).toMatchObject({ provider: 'default' });
    expect(completed.events[6]).toMatchObject({ reason: 'after_requeue', ok: true, node_id: 'node_alpha' });
    expect(alpha.sock.ofType('error')).toHaveLength(0);
  });

  it('shows a registered agent whose result was rejected, and tells the node why', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-rejected');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-moved');
    const beta = await attachNode(ws, 'node_beta', 'beta');

    // Alpha's heartbeat goes stale before its agent registers, so the spawn is
    // requeued and placed on beta.
    await makeHeartbeatStale('node_alpha');
    await sweepOfflineNodes(stack.runtime.handle.db, stack.runtime.realtime);
    expect(beta.sock.ofType('action.invoke').at(-1)).toMatchObject({ invocation_id: invocationId });

    // Alpha had in fact launched the agent; it registers, then reports.
    await alpha.register();
    await registerSpawnedAgent(alpha, 'worker-moved', invocationId);
    alpha.sock.received.length = 0;
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, id: 'result-1', type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-moved' },
    }));

    expect(alpha.sock.ofType('error').at(-1)).toMatchObject({
      id: 'result-1',
      ok: false,
      code: 'action_result_dispatched_to_other_node',
      message: expect.stringContaining(invocationId),
    });

    const invocation = await getInvocation(caller.token, invocationId);
    expect(invocation.status).toBe('dispatched');
    expect(types(invocation)).toEqual([
      'created', 'placed', 'dispatched', 'requeued', 'dispatched', 'agent_registered', 'result_rejected',
    ]);
    expect(invocation.events[3]).toMatchObject({ reason: 'node_lost', detail: 'liveness_timeout', node_id: 'node_alpha' });
    expect(invocation.events[4]).toMatchObject({ node_id: 'node_beta', attempt: 2 });
    expect(invocation.events[6]).toMatchObject({
      node_id: 'node_alpha', reason: 'dispatched_to_other_node', ok: true,
    });
    expect(invocation.registered_agent).toMatchObject({ name: 'worker-moved', node_id: 'node_alpha' });
    expect(invocation.explanation).toMatch(
      /^Node alpha launched agent worker-moved \(registered .* UTC\) but its result was rejected: invocation had been dispatched to node beta instead\.$/,
    );
  });

  it('settles a requeued spawn from its registered agent instead of launching it again', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-started');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-slow');
    await registerSpawnedAgent(alpha, 'worker-slow', invocationId);

    // The node launched and registered the agent but its result is late: the
    // dispatch timeout would otherwise requeue the spawn and launch it again.
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({ dispatchedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(actionInvocations.id, invocationId));
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, { neverDispatchedSweepGraceMs: 0 });

    const settled = await getInvocation(caller.token, invocationId);
    expect(settled.status).toBe('completed');
    expect(settled.output).toMatchObject({
      name: 'worker-slow',
      invocation_id: invocationId,
      node_id: 'node_alpha',
      started_from: 'agent_registration',
    });
    expect(settled.events.at(-1)).toMatchObject({
      type: 'started', reason: 'dispatch_timeout', agent_name: 'worker-slow', node_id: 'node_alpha',
    });
    expect(types(settled)).not.toContain('requeued');
    expect(alpha.sock.ofType('action.invoke')).toHaveLength(1);
    expect(settled.explanation).toMatch(
      /^Node alpha launched agent worker-slow \(registered .* UTC\); the invocation was marked completed from that registration instead of launching it again when it would have been requeued after no result arrived within the dispatch timeout\.$/,
    );

    // The node's own result arrives afterwards: a harmless repeat, recorded
    // but not reported back to the node as an error.
    alpha.sock.received.length = 0;
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-slow' },
    }));
    expect(alpha.sock.ofType('error')).toHaveLength(0);
    const after = await getInvocation(caller.token, invocationId);
    expect(after.status).toBe('completed');
    expect(after.events.at(-1)).toMatchObject({ type: 'result_rejected', reason: 'already_settled' });
  });

  it('holds a verify_ready spawn whose agent registered while the node waits for readiness, then requeues it', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-verify');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    // verify_ready requires a provider heartbeat proving handlers are live.
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    const res = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude', name: 'worker-ready', task: 'x', verify_ready: true } }),
    });
    expect(res.status).toBe(201);
    const invocationId = (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
    await registerSpawnedAgent(alpha, 'worker-ready', invocationId);

    const expireDispatch = () => stack.runtime.handle.db
      .update(actionInvocations)
      .set({ dispatchedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(actionInvocations.id, invocationId));
    const sweep = () => sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, { neverDispatchedSweepGraceMs: 0 });

    // The node holds a verified result until the harness is ready (up to 90 s),
    // past the 30 s dispatch timeout. Registration does not prove readiness, so
    // the spawn is neither completed nor requeued: the dispatch is held.
    await expireDispatch();
    await sweep();
    expect((await getInvocation(caller.token, invocationId)).explanation)
      .toMatch(/held past the dispatch timeout while the node waits for the harness to report ready\.$/);
    // A later event between sweeps must not re-record the hold.
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, id: 'bad-ready', type: 'action.result', invocation_id: invocationId, output: {}, error: 'x',
    }));
    await expireDispatch();
    await sweep();
    const held = await getInvocation(caller.token, invocationId);
    expect(held.status).toBe('dispatched');
    expect(types(held).filter((type) => type === 'started')).toHaveLength(1);
    expect(held.events.find((event) => event.type === 'started')).toMatchObject({ reason: 'awaiting_readiness', agent_name: 'worker-ready' });
    expect(types(held)).not.toContain('requeued');
    expect(alpha.sock.ofType('action.invoke')).toHaveLength(1);

    // The held result is applied normally.
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-ready', ready: true },
    }));
    const completed = await getInvocation(caller.token, invocationId);
    expect(completed.status).toBe('completed');
    expect(completed.explanation).toMatch(/^Node alpha launched agent worker-ready \(registered .* UTC\) and it reported success/);
  });

  it('requeues a verify_ready spawn once its readiness hold has passed', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-verify-expired');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    const res = await stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { cli: 'claude', name: 'worker-stuck', task: 'x', verify_ready: true } }),
    });
    expect(res.status).toBe(201);
    const invocationId = (await res.json() as { data: { invocation_id: string } }).data.invocation_id;
    await registerSpawnedAgent(alpha, 'worker-stuck', invocationId);
    await stack.runtime.handle.db
      .update(agents)
      .set({ metadata: { fleet: { node_id: 'node_alpha', invocation_id: invocationId, registered_at: new Date(Date.now() - 10 * 60_000).toISOString() } } })
      .where(eq(agents.name, 'worker-stuck'));
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({ dispatchedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(actionInvocations.id, invocationId));
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, { neverDispatchedSweepGraceMs: 0 });
    const invocation = await getInvocation(caller.token, invocationId);
    expect(invocation.status).not.toBe('completed');
    expect(types(invocation)).not.toContain('started');
    expect(invocation.events.find((event) => event.type === 'requeued')).toMatchObject({ reason: 'dispatch_timeout' });
  });

  it('finds an agent recovered under a later spawn invocation', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-recover');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const first = await spawn(caller.token, 'worker-again');
    await registerSpawnedAgent(alpha, 'worker-again', first);
    const agentId = (alpha.sock.ofType('reply').at(-1) as { data: { agent_id: string } }).data.agent_id;
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: first, output: { agent: 'worker-again' },
    }));

    const second = await spawn(caller.token, 'worker-again');
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, id: 'recover-1', type: 'agent.recover', name: 'worker-again', expected_agent_id: agentId,
      invocation_id: second, session_ref: 'pty://worker-again-2', resumable: false,
    }));
    expect(alpha.sock.ofType('reply').at(-1)).toMatchObject({ id: 'recover-1', ok: true });
    const recovered = await getInvocation(caller.token, second);
    expect(recovered.registered_agent).toMatchObject({ agent_id: agentId, name: 'worker-again', node_id: 'node_alpha' });
    expect(recovered.events.at(-1)).toMatchObject({ type: 'agent_registered', reason: 'recovered', agent_id: agentId });
    expect((await getInvocation(caller.token, first)).registered_agent).toBeNull();
  });

  it('acknowledges every correlated result: applied, then already applied on a resend', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-ack');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-ack');
    alpha.sock.received.length = 0;
    const result = JSON.stringify({
      v: 1, id: 'result-ack-1', type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-ack' },
    });
    await alpha.handle.handleMessage(result);
    expect(alpha.sock.ofType('reply').at(-1)).toEqual({
      v: 1, id: 'result-ack-1', type: 'reply', ok: true,
      data: { invocation_id: invocationId, outcome: 'applied', status: 'completed' },
    });
    // The node resends until acknowledged; a resend of an applied result is acknowledged too.
    await alpha.handle.handleMessage(result);
    expect(alpha.sock.ofType('reply').at(-1)).toMatchObject({
      id: 'result-ack-1', ok: true, data: { invocation_id: invocationId, outcome: 'already_applied' },
    });
    expect(alpha.sock.ofType('error')).toHaveLength(0);
    // A result without an id keeps the legacy fire-and-forget behaviour.
    const second = await spawn(caller.token, 'worker-ack-2');
    alpha.sock.received.length = 0;
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, type: 'action.result', invocation_id: second, output: {},
    }));
    expect(alpha.sock.ofType('reply')).toHaveLength(0);
  });

  it('retries a result through transient database pressure and applies it', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-pressure-retry');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-retry');
    const restore = injectUpdateFailure(
      stack.runtime.deps.db, actionInvocations, 'D1_ERROR: D1 DB is overloaded. Requests queued for too long', { times: 1 },
    );
    try {
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1, id: 'result-retry-1', type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-retry' },
      }));
    } finally {
      restore();
    }
    expect(alpha.sock.ofType('reply').at(-1)).toMatchObject({ id: 'result-retry-1', data: { outcome: 'applied' } });
    expect((await getInvocation(caller.token, invocationId)).status).toBe('completed');
  });

  it('refuses a result under sustained database pressure with a retryable, correlated error and records it', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-pressure');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-pressure');
    await registerSpawnedAgent(alpha, 'worker-pressure', invocationId);
    alpha.sock.received.length = 0;
    // Every attempt's write fails; the refusal record afterwards gets through.
    const restore = injectUpdateFailure(
      stack.runtime.deps.db, actionInvocations, 'D1_ERROR: D1 DB is overloaded. Too many requests queued', { times: 3 },
    );
    try {
      await alpha.handle.handleMessage(JSON.stringify({
        v: 1, id: 'result-pressure-1', type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-pressure' },
      }));
    } finally {
      restore();
    }
    expect(alpha.sock.ofType('error').at(-1)).toMatchObject({
      id: 'result-pressure-1', ok: false, code: 'd1_pressure', message: expect.stringContaining('resend it'),
    });
    const refused = await getInvocation(caller.token, invocationId);
    expect(refused.status).toBe('dispatched');
    expect(refused.events.at(-1)).toMatchObject({ type: 'result_refused', reason: 'd1_pressure', node_id: 'node_alpha' });
    expect(refused.explanation).toMatch(
      /^Node alpha launched agent worker-pressure \(registered .* UTC\) but its result was refused under database pressure at .* UTC; waiting for the node to resend it\.$/,
    );

    // The node resends with the same id and it is applied and acknowledged.
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, id: 'result-pressure-1', type: 'action.result', invocation_id: invocationId, output: { agent: 'worker-pressure' },
    }));
    expect(alpha.sock.ofType('reply').at(-1)).toMatchObject({ id: 'result-pressure-1', data: { outcome: 'applied' } });
    const applied = await getInvocation(caller.token, invocationId);
    expect(applied.status).toBe('completed');
    expect(applied.explanation).toMatch(/and it reported success/);
  });

  it('lets a socket owner record a result it refused before the engine saw it', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-host-refusal');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-host');
    const raw = JSON.stringify({ v: 1, id: 'r1', type: 'action.result', invocation_id: invocationId, output: {} });
    expect(await recordNodeFrameRefused({
      db: stack.runtime.deps.db, workspaceId: ws.workspaceId, nodeId: 'node_alpha', raw, reason: 'd1_pressure',
    })).toBe(true);
    // A node never placed on the invocation cannot annotate it.
    expect(await recordNodeFrameRefused({
      db: stack.runtime.deps.db, workspaceId: ws.workspaceId, nodeId: 'node_other', raw, reason: 'd1_pressure',
    })).toBe(false);
    const invocation = await getInvocation(caller.token, invocationId);
    expect(invocation.explanation).toMatch(
      /^Node alpha reported a result but its result was refused under database pressure at .* UTC; waiting for the node to resend it\.$/,
    );
  });

  it('answers a result for an unknown invocation and records a malformed one', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-invalid');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const alpha = await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-bad');

    alpha.sock.received.length = 0;
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, id: 'unknown-1', type: 'action.result', invocation_id: 'inv_missing', output: {},
    }));
    expect(alpha.sock.ofType('error').at(-1)).toMatchObject({
      id: 'unknown-1', code: 'action_result_unknown_invocation',
    });

    // output and error together fail the wire schema.
    await alpha.handle.handleMessage(JSON.stringify({
      v: 1, id: 'bad-1', type: 'action.result', invocation_id: invocationId, output: {}, error: 'boom',
    }));
    expect(alpha.sock.ofType('error').at(-1)).toMatchObject({ id: 'bad-1', code: 'invalid_message' });
    const invocation = await getInvocation(caller.token, invocationId);
    expect(invocation.status).toBe('dispatched');
    expect(invocation.events.at(-1)).toMatchObject({
      type: 'result_rejected', reason: 'invalid_payload', node_id: 'node_alpha',
    });
    expect(invocation.explanation).toMatch(/^A result from node alpha was rejected at .* UTC: the result frame was malformed/);

    // Another node cannot write to this invocation's timeline.
    const beta = await attachNode(ws, 'node_beta', 'beta');
    await beta.handle.handleMessage(JSON.stringify({
      v: 1, id: 'foreign-1', type: 'action.result', invocation_id: invocationId, output: {},
    }));
    expect(beta.sock.ofType('error').at(-1)).toMatchObject({ code: 'action_result_dispatched_to_other_node' });
    const unchanged = await getInvocation(caller.token, invocationId);
    expect(unchanged.events).toHaveLength(invocation.events.length);
  });

  it('bounds the timeline and keeps its first event', async () => {
    const ws = await createWorkspace(stack.app, 'timeline-bound');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    await attachNode(ws, 'node_alpha', 'alpha');
    const invocationId = await spawn(caller.token, 'worker-bound');
    for (let index = 0; index < INVOCATION_EVENT_LIMIT + 10; index++) {
      await recordInvocationEvent(
        stack.runtime.handle.db,
        ws.workspaceId,
        invocationId,
        invocationEvent('queued', { reason: `probe-${index}` }),
      );
    }
    const [row] = await stack.runtime.handle.db
      .select({ events: actionInvocations.events })
      .from(actionInvocations)
      .where(and(eq(actionInvocations.workspaceId, ws.workspaceId), eq(actionInvocations.id, invocationId)));
    expect(row!.events).toHaveLength(INVOCATION_EVENT_LIMIT);
    expect(row!.events[0]).toMatchObject({ type: 'created' });
    expect(row!.events.at(-1)).toMatchObject({ reason: `probe-${INVOCATION_EVENT_LIMIT + 9}` });
  });
});

describe('explainInvocation', () => {
  it('names the node, the registered agent, and why its result was rejected', () => {
    const explanation = explainInvocation({
      status: 'pending',
      error: null,
      actionName: 'spawn',
      dispatchedNodeId: null,
      dispatchedAt: null,
      completedAt: null,
      retryAfterAt: null,
      nodeNames: new Map([['node_finn', 'finn-mac-mini-desktop']]),
      registeredAgent: null,
      events: [
        { at: '2026-10-15T07:30:00.000Z', type: 'dispatched', node_id: 'node_finn', attempt: 1 },
        { at: '2026-10-15T07:30:30.000Z', type: 'requeued', node_id: 'node_finn', reason: 'node_lost', detail: 'liveness_timeout' },
        { at: '2026-10-15T07:30:41.000Z', type: 'agent_registered', node_id: 'node_finn', agent_id: 'a1', agent_name: 'proof-claude-1' },
        { at: '2026-10-15T07:31:10.000Z', type: 'result_rejected', node_id: 'node_finn', reason: 'not_dispatched', ok: false, error: 'boom' },
      ],
    });
    expect(explanation).toBe(
      'Node finn-mac-mini-desktop launched agent proof-claude-1 (registered 07:30:41 UTC) but its result was rejected:'
      + " invocation was requeued at 07:30:30 UTC after the node's heartbeat went stale.",
    );
  });

  it('stops describing a readiness hold once a later dispatch supersedes it', () => {
    const base = {
      status: 'dispatched', error: null, actionName: 'spawn', dispatchedNodeId: 'node_b',
      dispatchedAt: '2026-10-15T07:35:00.000Z', completedAt: null, retryAfterAt: null,
      nodeNames: new Map([['node_a', 'alpha'], ['node_b', 'beta']]), registeredAgent: null,
    };
    const hold = { at: '2026-10-15T07:31:00.000Z', type: 'started', node_id: 'node_a', agent_name: 'w', reason: 'awaiting_readiness' };
    expect(explainInvocation({ ...base, dispatchedNodeId: 'node_a', events: [
      { at: '2026-10-15T07:30:00.000Z', type: 'dispatched', node_id: 'node_a', attempt: 1 },
      { at: '2026-10-15T07:30:20.000Z', type: 'agent_registered', node_id: 'node_a', agent_name: 'w' },
      hold,
    ] })).toMatch(/held past the dispatch timeout/);
    expect(explainInvocation({ ...base, events: [
      { at: '2026-10-15T07:30:00.000Z', type: 'dispatched', node_id: 'node_a', attempt: 1 },
      hold,
      { at: '2026-10-15T07:33:00.000Z', type: 'requeued', node_id: 'node_a', reason: 'dispatch_timeout' },
      { at: '2026-10-15T07:35:00.000Z', type: 'dispatched', node_id: 'node_b', attempt: 2 },
    ] })).toBe('Dispatched to node beta at 07:35:00 UTC (attempt 2); waiting for the node to report a result.');
  });

  it('describes a never-dispatched spawn', () => {
    expect(explainInvocation({
      status: 'pending', error: null, actionName: 'spawn', dispatchedNodeId: null, dispatchedAt: null,
      completedAt: null, retryAfterAt: null, nodeNames: new Map(), registeredAgent: null,
      events: [{ at: '2026-10-15T07:30:00.000Z', type: 'created' }],
    })).toBe('Waiting for a node that can run it; not dispatched yet.');
  });
});
