import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  attachDirectNodeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import {
  PENDING_INVOCATION_MAX_AGE_MS,
  sweepTimedOutInvocations,
} from '../../engine/action.js';
import { actionInvocations } from '../../db/schema.js';

// Issue #357: a `pending` invocation that was never dispatched to any node
// (`dispatch_attempts = 0`) has no handler connection for the 0032 TTL sweep
// to observe unreachable, so its clock never starts and the row can sit
// pending indefinitely. When a matching node eventually returns, week-old
// spawn briefs drain into live agents that can evict the resident chief's
// token — a delayed-action identity hazard. The fix bounds such rows by
// absolute age with a distinguishing error (`never_dispatched_expired`).

function registerBody(handler: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'crm.get_person_batch',
    description: 'Fetch a batch of people',
    handler_agent: handler,
    ...overrides,
  });
}

async function insertPendingInvocation(
  stack: TestStack,
  workspaceId: string,
  opts: { id: string; createdAt: Date; dispatchAttempts?: number },
): Promise<void> {
  await stack.runtime.handle.db.insert(actionInvocations).values({
    id: opts.id,
    workspaceId,
    actionId: null,
    actionName: 'spawn',
    callerId: null,
    callerName: null,
    input: { capability: 'claude' },
    status: 'pending',
    dispatchAttempts: opts.dispatchAttempts ?? 0,
    createdAt: opts.createdAt,
  });
}

async function readInvocation(stack: TestStack, id: string) {
  const [row] = await stack.runtime.handle.db
    .select({
      status: actionInvocations.status,
      error: actionInvocations.error,
      dispatchAttempts: actionInvocations.dispatchAttempts,
    })
    .from(actionInvocations)
    .where(eq(actionInvocations.id, id));
  return row;
}

describe('pending invocation age bound (issue #357)', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  // must-fire
  it('fails a never-dispatched pending invocation older than the age bound with never_dispatched_expired', async () => {
    const ws = await createWorkspace(stack.app, 'ndx-must-fire');

    const staleId = 'inv_stale_never_dispatched';
    await insertPendingInvocation(stack, ws.workspaceId, {
      id: staleId,
      createdAt: new Date(Date.now() - 10_000),
      dispatchAttempts: 0,
    });

    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      pendingInvocationMaxAgeMs: 1_000,
      neverDispatchedSweepGraceMs: 0,
    });

    const row = await readInvocation(stack, staleId);
    expect(row).toMatchObject({ status: 'failed', error: 'never_dispatched_expired' });
  });

  // must-not-fire
  it('leaves a recently created pending invocation alone', async () => {
    const ws = await createWorkspace(stack.app, 'ndx-recent-untouched');

    const freshId = 'inv_fresh_never_dispatched';
    await insertPendingInvocation(stack, ws.workspaceId, {
      id: freshId,
      createdAt: new Date(),
      dispatchAttempts: 0,
    });

    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      pendingInvocationMaxAgeMs: PENDING_INVOCATION_MAX_AGE_MS,
      neverDispatchedSweepGraceMs: 0,
    });

    const row = await readInvocation(stack, freshId);
    expect(row.status).toBe('pending');
    expect(row.error).toBeNull();
  });

  // must-not-fire: existing 0032 TTL guard is not regressed. A dispatched-then-
  // unreachable invocation still inside the handler-unreachable TTL is left
  // alone by the new age bound (it has dispatch_attempts > 0) AND by the
  // existing sweep (the TTL has not elapsed).
  it('leaves a dispatched-then-unreachable invocation inside the handler TTL alone', async () => {
    const ws = await createWorkspace(stack.app, 'ndx-inside-ttl');
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

    // Backdate past the new age bound. The row was dispatched
    // (dispatch_attempts > 0), so the age bound must NOT touch it.
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({ createdAt: new Date(Date.now() - PENDING_INVOCATION_MAX_AGE_MS - 60_000) })
      .where(eq(actionInvocations.id, invocationId));

    await handlerNode.handle.handleClose();

    // First sweep observes the disconnect: stamps handler_unreachable_since,
    // no failure yet. Age bound must not fire (dispatch_attempts > 0).
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 60_000,
      pendingInvocationMaxAgeMs: 1_000,
      neverDispatchedSweepGraceMs: 0,
    });

    const row = await readInvocation(stack, invocationId);
    expect(['pending', 'dispatched']).toContain(row.status);
    expect(row.error).toBeNull();
    expect(row.dispatchAttempts).toBeGreaterThan(0);
  });

  // must-not-fire: isolate the `dispatch_attempts = 0` filter. A `pending` row
  // whose `dispatchAttempts > 0` (e.g. rescheduled back to pending after a prior
  // dispatch) is exactly the handler-unreachable TTL's territory and the new age
  // bound must NOT touch it — even when the row is past the cutoff. The earlier
  // must-not-fire uses a `dispatched` row, so this case isolates the attempts
  // filter from the status filter and proves each is load-bearing on its own.
  it('leaves a pending row with dispatch_attempts > 0 past the cutoff alone', async () => {
    const ws = await createWorkspace(stack.app, 'ndx-attempts-nonzero');

    const requeuedId = 'inv_requeued_pending';
    await insertPendingInvocation(stack, ws.workspaceId, {
      id: requeuedId,
      createdAt: new Date(Date.now() - 10_000),
      dispatchAttempts: 1,
    });

    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      pendingInvocationMaxAgeMs: 1_000,
      neverDispatchedSweepGraceMs: 0,
    });

    const row = await readInvocation(stack, requeuedId);
    expect(row.status).toBe('pending');
    expect(row.error).toBeNull();
    expect(row.dispatchAttempts).toBe(1);
  });

  // Prove the must-not-fire guard can actually fail: remove the dispatch_attempts
  // qualifier on the row and the age bound will (correctly) fire on it. If this
  // control test doesn't turn red, the must-not-fire above is not really testing
  // the age bound — the row was safe for some other reason.
  it('control: the same row IS failed if its dispatch_attempts qualifier is removed', async () => {
    const ws = await createWorkspace(stack.app, 'ndx-control');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'worker');
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');

    await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: registerBody('orchestrator'),
    });
    const handlerNode = await attachDirectNodeSocket(stack, ws.workspaceId, handler);
    const invoke = await stack.app.request('/v1/actions/crm.get_person_batch/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${caller.token}` },
      body: JSON.stringify({ input: { batchSize: 5 } }),
    });
    const invocationId = (await invoke.json() as { data: { invocation_id: string } }).data.invocation_id;

    // Simulate the never-dispatched shape on an old row: restore status to
    // 'pending', zero dispatch_attempts, and backdate. The age bound MUST fire,
    // proving the must-not-fire above is guarded by the (status, dispatch_attempts)
    // qualifier rather than by accident.
    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({
        status: 'pending',
        dispatchAttempts: 0,
        dispatchedAt: null,
        dispatchedNodeId: null,
        dispatchedProvider: null,
        createdAt: new Date(Date.now() - 10_000),
      })
      .where(eq(actionInvocations.id, invocationId));

    await handlerNode.handle.handleClose();

    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
      handlerUnreachableTtlMs: 60_000,
      pendingInvocationMaxAgeMs: 1_000,
      neverDispatchedSweepGraceMs: 0,
    });

    const row = await readInvocation(stack, invocationId);
    expect(row).toMatchObject({ status: 'failed', error: 'never_dispatched_expired' });
  });
});
