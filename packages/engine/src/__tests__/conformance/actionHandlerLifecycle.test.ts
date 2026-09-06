import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  attachDirectNodeSocket,
  deliverFramesOfType,
  FakeSocket,
  type TestStack,
} from './harness.js';
import { sweepTimedOutInvocations } from '../../engine/action.js';
import { actionInvocations, actions, agents } from '../../db/schema.js';

// Issue #241: agent-published actions from an ephemeral publisher (register on
// connect, re-register on every reconnect) must be able to re-assert their
// registration, and invoking an action whose handler is gone must fail fast
// instead of queueing a pending invocation the caller waits on forever.

function registerBody(handler: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'crm.get_person_batch',
    description: 'Fetch a batch of people',
    handler_agent: handler,
    ...overrides,
  });
}

describe('agent-published action lifecycle', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('re-registering the same (workspace, name) refreshes the row instead of failing', async () => {
    const ws = await createWorkspace(stack.app, 'action-upsert');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const first = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator', { input_schema: { type: 'object' } }),
    });
    expect(first.status).toBe(201);
    const created = (await first.json() as { data: { id: string } }).data;

    const second = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator', {
        description: 'Fetch people (v2)',
        input_schema: { type: 'object', properties: { batchSize: { type: 'integer' } } },
        available_to: ['worker'],
      }),
    });
    expect(second.status).toBe(200);
    const refreshed = (await second.json() as { data: {
      id: string; description: string; input_schema: Record<string, unknown>; available_to: string[];
    } }).data;

    // Same row, refreshed fields — not a duplicate and not a 500.
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.description).toBe('Fetch people (v2)');
    expect(refreshed.input_schema).toEqual({ type: 'object', properties: { batchSize: { type: 'integer' } } });
    expect(refreshed.available_to).toEqual(['worker']);
  });

  it('re-registering under a fresh handler identity heals the handler pointer', async () => {
    const ws = await createWorkspace(stack.app, 'action-heal');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const oldIdentity = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator-run1');
    const newIdentity = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator-run2');

    const first = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${oldIdentity.token}` },
      body: registerBody('orchestrator-run1'),
    });
    expect(first.status).toBe(201);
    const actionId = (await first.json() as { data: { id: string } }).data.id;

    // The old identity is gone; the next run re-asserts the action under its
    // fresh identity (register-on-connect).
    const second = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${newIdentity.token}` },
      body: registerBody('orchestrator-run2'),
    });
    expect(second.status).toBe(200);
    const refreshed = (await second.json() as { data: { id: string; handler_agent: string } }).data;
    expect(refreshed.id).toBe(actionId);
    expect(refreshed.handler_agent).toBe('orchestrator-run2');

    // Invocations now reach the fresh identity.
    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, newIdentity);
    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(handlerNode.sock.ofType('action.invoke').at(-1)).toMatchObject({
      action: 'crm.get_person_batch',
      agent_id: newIdentity.agentId,
      input: { batchSize: 5 },
    });
  });

  it('re-asserting a node action via handler_node refreshes it and keeps the provider owner', async () => {
    const ws = await createWorkspace(stack.app, 'action-node-upsert');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');

    const enroll = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_a', name: 'alpha', role: 'broker', capabilities: [], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(enroll.status).toBe(201);

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_a', sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg-1', type: 'node.register', node_id: 'node_a', name: 'alpha',
      capabilities: [{ name: 'work', kind: 'action' }], max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true }));

    // The provider materialized `work`; asserting it over HTTP refreshes the
    // same row (200) instead of tripping the (workspace, node, name) index.
    const assertRes = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'work', description: 'Documented work action', handler_node: 'alpha' }),
    });
    expect(assertRes.status).toBe(200);

    const [row] = await stack.runtime.handle.db
      .select({ description: actions.description, handlerProvider: actions.handlerProvider })
      .from(actions)
      .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.name, 'work')));
    expect(row.description).toBe('Documented work action');
    // Provider ownership survives the refresh so dispatch still resolves.
    expect(row.handlerProvider).toBe('default');

    const invoke = await stack.app.request('/v1/actions/work/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { job: 1 } }),
    });
    expect(invoke.status).toBe(201);
    expect(sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'work', input: { job: 1 } });

    // Legacy HTTP-created node actions stored the default provider as null.
    // Dispatch and socket-owner authorization must normalize that value the
    // same way rather than accepting the route and dropping its frame.
    await stack.runtime.handle.db
      .update(actions)
      .set({ handlerProvider: null })
      .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.name, 'work')));
    sock.received.length = 0;
    const legacyInvoke = await stack.app.request('/v1/actions/work/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { job: 2 } }),
    });
    expect(legacyInvoke.status).toBe(201);
    expect(sock.ofType('action.invoke').at(-1)).toMatchObject({ action: 'work', input: { job: 2 } });
  });

  it('invoking an action whose handler points at a dead connection fails fast with handler_unavailable', async () => {
    const ws = await createWorkspace(stack.app, 'action-fail-fast');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);

    // The handler identity is dead: it connected once, then its process went
    // away (the stale-pointer shape from the incident). Pin the location back
    // to the now-dead node in case disconnect cleanup re-homed it.
    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    await handlerNode.handle.handleClose();
    await stack.runtime.handle.db
      .update(agents)
      .set({ locationType: 'via_node', locationNodeId: handlerNode.nodeId })
      .where(eq(agents.id, handler.agentId));

    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(503);
    await expect(invoke.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'handler_unavailable' },
    });

    // No orphaned invocation is left queueing toward the dead handler.
    const open = await stack.runtime.handle.db
      .select({ id: actionInvocations.id })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        inArray(actionInvocations.status, ['pending', 'dispatched', 'invoked']),
      ));
    expect(open).toHaveLength(0);
  });

  it('an invocation stuck on an unreachable handler is failed after the TTL and the caller is told', async () => {
    const ws = await createWorkspace(stack.app, 'action-ttl');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);

    const callerNode = await attachDirectNodeSocket(stack, ws.workspaceId, caller);
    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);

    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;

    // The handler dies without answering.
    await handlerNode.handle.handleClose();

    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 0,
      completionDeps: stack.runtime.deps,
    });

    const [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(row).toMatchObject({ status: 'failed', error: 'handler_unavailable' });

    // The caller received an action.failed event instead of hanging forever.
    await new Promise((r) => setTimeout(r, 50));
    const failed = deliverFramesOfType(callerNode.sock, 'action.failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((failed.at(-1)!.payload as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: invocationId,
      error: 'handler_unavailable',
    });
  });

  it('a handler takeover preserves work already accepted by the previous handler', async () => {
    const ws = await createWorkspace(stack.app, 'action-takeover-inflight');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const oldIdentity = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator-run1');
    const newIdentity = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator-run2');

    const first = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${oldIdentity.token}` },
      body: registerBody('orchestrator-run1'),
    });
    expect(first.status).toBe(201);

    const oldNode = await attachDirectNodeSocket(stack, ws.workspaceId, oldIdentity);
    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(oldNode.sock.ofType('action.invoke')).toHaveLength(1);

    // A different identity takes over the action after the old handler has
    // accepted the frame. That exact route remains authoritative until its
    // provider completes; takeover applies only to future invocations.
    const second = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${newIdentity.token}` },
      body: registerBody('orchestrator-run2'),
    });
    expect(second.status).toBe(200);

    const [row] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        status: actionInvocations.status,
        error: actionInvocations.error,
        providerAcceptedAttempt: actionInvocations.providerAcceptedAttempt,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(row).toMatchObject({ actionId: null, status: 'dispatched', error: null });
    expect(row.providerAcceptedAttempt).toBe(row.dispatchAttempts);
    await oldNode.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: invocationId,
      output: { accepted_before_takeover: true },
    }));
    const [completedOld] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, output: actionInvocations.output })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(completedOld).toEqual({
      status: 'completed',
      output: { accepted_before_takeover: true },
    });

    // A re-register by the SAME handler (the common register-on-connect no-op)
    // must NOT fail its own in-flight invocations.
    const reinvoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 1 } }),
    });
    expect(reinvoke.status).toBe(503); // new handler has no live connection yet
    const newNode = await attachDirectNodeSocket(stack, ws.workspaceId, newIdentity);
    const invoke2 = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 2 } }),
    });
    expect(invoke2.status).toBe(201);
    const invocation2 = (await invoke2.json() as { data: { invocation_id: string } }).data.invocation_id;
    expect(newNode.sock.ofType('action.invoke')).toHaveLength(1);

    const refresh = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${newIdentity.token}` },
      body: registerBody('orchestrator-run2', { description: 'refreshed' }),
    });
    expect(refresh.status).toBe(200);
    const [row2] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocation2));
    expect(['pending', 'dispatched']).toContain(row2.status);
  });

  it('deleting an action before provider acceptance fails its invocation and notifies the caller', async () => {
    const ws = await createWorkspace(stack.app, 'action-delete-inflight');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);

    const callerNode = await attachDirectNodeSocket(stack, ws.workspaceId, caller);
    await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const registry = stack.runtime.realtime;
    const originalSend = registry.sendAuthorizedActionToProvider!.bind(registry);
    let releaseAuthorization!: () => void;
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => { markAuthorizationStarted = resolve; });
    const authorizationRelease = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let pause = true;
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      if (pause && args[4].kind === 'agent-action-v1') {
        pause = false;
        markAuthorizationStarted();
        await authorizationRelease;
      }
      return originalSend(...args);
    });
    const invokePromise = stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    await authorizationStarted;
    const [open] = await stack.runtime.handle.db
      .select({ id: actionInvocations.id })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionName, 'crm.get_person_batch'),
      ));
    const invocationId = open.id;

    const del = await stack.app.request('/v1/actions/crm.get_person_batch', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(del.status).toBe(204);
    releaseAuthorization();
    expect((await invokePromise).status).toBe(503);

    // The open invocation is terminally failed (action delete sets actionId
    // null, which would otherwise orphan it outside the TTL sweep's join).
    const [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(row).toMatchObject({ status: 'failed', error: 'action_deleted' });

    await new Promise((r) => setTimeout(r, 50));
    const failed = deliverFramesOfType(callerNode.sock, 'action.failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect((failed.at(-1)!.payload as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: invocationId,
      error: 'action_deleted',
    });
  });

  it('keeps an accepted agent-hosted generation completable after its action is replaced', async () => {
    const ws = await createWorkspace(stack.app, 'agent-action-accepted-generation');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');
    const replacement = await registerAgent(stack.app, ws.workspaceKey, 'replacement');
    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);
    const originalActionId = (await register.json() as { data: { id: string } }).data.id;
    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);

    const registry = stack.runtime.realtime;
    const originalSend = registry.sendAuthorizedActionToProvider!.bind(registry);
    let releaseAccepted!: () => void;
    let markAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    const acceptedRelease = new Promise<void>((resolve) => { releaseAccepted = resolve; });
    let pause = true;
    vi.spyOn(registry, 'sendAuthorizedActionToProvider').mockImplementation(async (...args) => {
      const sent = await originalSend(...args);
      if (pause && args[4].kind === 'agent-action-v1') {
        pause = false;
        markAccepted();
        await acceptedRelease;
      }
      return sent;
    });

    const invokePromise = stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    await accepted;
    const [acceptedRow] = await stack.runtime.handle.db
      .select({
        id: actionInvocations.id,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        dispatchedProvider: actionInvocations.dispatchedProvider,
        providerAcceptedAttempt: actionInvocations.providerAcceptedAttempt,
        dispatchAttempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(and(
        eq(actionInvocations.workspaceId, ws.workspaceId),
        eq(actionInvocations.actionId, originalActionId),
      ));
    expect(acceptedRow).toMatchObject({
      dispatchedNodeId: handlerNode.nodeId,
      dispatchedProvider: 'default',
    });
    expect(acceptedRow.providerAcceptedAttempt).toBe(acceptedRow.dispatchAttempts);

    await stack.runtime.handle.db
      .delete(actions)
      .where(and(eq(actions.workspaceId, ws.workspaceId), eq(actions.id, originalActionId)));
    const replace = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${replacement.token}` },
      body: registerBody('replacement'),
    });
    expect(replace.status).toBe(201);
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({ dispatchedAt: new Date(0), retryAfterAt: new Date(0) })
      .where(eq(actionInvocations.id, acceptedRow.id));

    expect(await sweepTimedOutInvocations(
      stack.runtime.handle.db,
      registry,
      { timeoutMs: 0 },
    )).toBe(0);
    const [preserved] = await stack.runtime.handle.db
      .select({
        actionId: actionInvocations.actionId,
        status: actionInvocations.status,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        dispatchedProvider: actionInvocations.dispatchedProvider,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, acceptedRow.id));
    expect(preserved).toEqual({
      actionId: null,
      status: 'dispatched',
      dispatchedNodeId: handlerNode.nodeId,
      dispatchedProvider: 'default',
    });

    await handlerNode.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'action.result',
      invocation_id: acceptedRow.id,
      output: { original_generation: true },
    }));
    releaseAccepted();
    expect((await invokePromise).status).toBe(201);
    const [completed] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, output: actionInvocations.output })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, acceptedRow.id));
    expect(completed).toEqual({
      status: 'completed',
      output: { original_generation: true },
    });
  });

  it('the TTL clock starts at the first unreachable observation, not invocation age', async () => {
    const ws = await createWorkspace(stack.app, 'action-ttl-grace');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);

    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;

    // Backdate the invocation far past the TTL: age alone must NOT make the
    // first post-disconnect sweep kill it — the handler still gets its grace.
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(actionInvocations.id, invocationId));

    await handlerNode.handle.handleClose();

    // First sweep observes the disconnect: stamps the observation, no failure.
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 50,
      completionDeps: stack.runtime.deps,
    });
    let [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, since: actionInvocations.handlerUnreachableSince })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(['pending', 'dispatched']).toContain(row.status);
    expect(row.since).not.toBeNull();

    // Still unreachable past the TTL: the next sweep fails it.
    await new Promise((r) => setTimeout(r, 60));
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 50,
      completionDeps: stack.runtime.deps,
    });
    [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, since: actionInvocations.handlerUnreachableSince })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(row.status).toBe('failed');
  });

  it('a handler reconnect clears the unreachable observation instead of failing', async () => {
    const ws = await createWorkspace(stack.app, 'action-ttl-recover');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);

    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;

    // Disconnect → sweep stamps the observation (TTL far away, no failure).
    await handlerNode.handle.handleClose();
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 60_000,
      completionDeps: stack.runtime.deps,
    });
    let [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, since: actionInvocations.handlerUnreachableSince })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(['pending', 'dispatched']).toContain(row.status);
    expect(row.since).not.toBeNull();

    // Reconnect (a restart) → sweep clears the observation; invocation lives.
    await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 60_000,
      completionDeps: stack.runtime.deps,
    });
    [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, since: actionInvocations.handlerUnreachableSince })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    expect(['pending', 'dispatched']).toContain(row.status);
    expect(row.since).toBeNull();
  });

  it('a live handler is not failed by the TTL sweep', async () => {
    const ws = await createWorkspace(stack.app, 'action-ttl-live');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    expect(register.status).toBe(201);

    await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    expect(invoke.status).toBe(201);
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;

    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 0,
      completionDeps: stack.runtime.deps,
    });

    const [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, invocationId));
    // Still open — a slow-but-connected handler keeps the invocation alive.
    expect(['pending', 'dispatched']).toContain(row.status);
  });
});
