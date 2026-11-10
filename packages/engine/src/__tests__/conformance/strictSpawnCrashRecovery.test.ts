import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { actionInvocations, nodeProviders, nodes } from '../../db/tables.js';
import type { EngineDb } from '../../ports/database.js';
import {
  ACTION_DISPATCH_TIMEOUT_MS,
  detachInvocationsFromLostNode,
  rescheduleNodeInvocation,
  rescheduleInvocationsForLostNode,
  sweepTimedOutInvocations,
} from '../../engine/action.js';
import {
  claimStrictSpawnDispatch,
  placeStrictSpawn,
  restoreStrictSpawnDispatch,
} from '../../engine/strictSpawnPlacement.js';
import { settleNodeOffline } from '../../engine/node.js';
import { configureNodeLiveness } from '../../engine/nodeLiveness.js';
import type { NodeLivenessSnapshot } from '../../ports/nodeLiveness.js';
import {
  attachFakeBatch,
  attachDirectNodeSocket,
  createWorkspace,
  deliverFramesOfType,
  FakeSocket,
  injectUpdateFailure,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { conformancePgDb } from './pgMode.js';

const schema = 'relay.spawn.invoke.logical/1';

function strictLogicalRequest(nodeId: string, nodeName: string) {
  return {
    schema,
    target_node_id: nodeId,
    target_node: nodeName,
    name: 'worker',
    cli: 'claude',
    task: 'prove crash recovery',
    directory: '/repo',
    verify_ready: true,
  };
}

function strictRequestInput(
  logical: ReturnType<typeof strictLogicalRequest>,
  workerCwd = '/materialized/repo',
) {
  return {
    spawn_contract: schema,
    target_node_id: logical.target_node_id,
    target_node: logical.target_node,
    name: logical.name,
    cli: logical.cli,
    task: logical.task,
    worker_cwd: workerCwd,
    verify_ready: logical.verify_ready,
    logical_request: logical,
  };
}

function strictStoredInput(logical: ReturnType<typeof strictLogicalRequest>) {
  return { ...strictRequestInput(logical), spawn_contract_applied: schema };
}

function strictInvocationId(workspaceId: string, callerId: string, key: string): string {
  return `inv_idem_${createHash('sha256')
    .update(['action-invoke-v1', workspaceId, callerId, 'spawn', key].join('\0'))
    .digest('hex')}`;
}

describe('strict spawn crash recovery', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  it('refuses REST completion before a strict claim is placed', async () => {
    const fixture = await setup();
    const key = 'inserted-before-placement';
    await insertStrictClaim(fixture, key);

    const completion = await stack.app.request(
      `/v1/actions/spawn/invocations/${fixture.invocationId(key)}/complete`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.caller.token}`,
        },
        body: JSON.stringify({ output: { agent: 'forged' } }),
      },
    );
    expect(completion.status).toBe(403);
    expect(await completion.json()).toMatchObject({ error: { code: 'node_owned_invocation' } });

    const [invocation] = await fixture.db
      .select({
        status: actionInvocations.status,
        handlerNodeId: actionInvocations.handlerNodeId,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(invocation).toEqual({ status: 'pending', handlerNodeId: null, dispatchedNodeId: null });
  });

  it('resumes an exact-node claim after a crash immediately after invocation insert', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'insert-crash');

    const response = await fixture.invoke('insert-crash');
    expect(response.status).toBe(201);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(fixture.sock.ofType('action.invoke')).toEqual([
      expect.objectContaining({ action: 'spawn:claude', invocation_id: fixture.invocationId('insert-crash') }),
    ]);
    await expectSingleOwnedReservation(fixture, 'insert-crash');
  });

  it('refreshes a rematerialized cwd before dispatching an unsent strict claim', async () => {
    const fixture = await setup();
    const key = 'rematerialized-cwd';
    await insertStrictClaim(fixture, key);

    const response = await fixture.invoke(key, '/materialized/repo-after-retry');
    expect(response.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toEqual([
      expect.objectContaining({
        invocation_id: fixture.invocationId(key),
        input: expect.objectContaining({ worker_cwd: '/materialized/repo-after-retry' }),
      }),
    ]);
    const [invocation] = await fixture.db
      .select({ input: actionInvocations.input })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(invocation.input).toMatchObject({ worker_cwd: '/materialized/repo-after-retry' });
  });

  it('does not change a strict cwd after dispatch has begun', async () => {
    const fixture = await setup();
    const key = 'immutable-dispatched-cwd';

    expect((await fixture.invoke(key, '/materialized/original')).status).toBe(201);
    expect((await fixture.invoke(key, '/materialized/retry')).status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toEqual([
      expect.objectContaining({
        invocation_id: fixture.invocationId(key),
        input: expect.objectContaining({ worker_cwd: '/materialized/original' }),
      }),
    ]);
    const [invocation] = await fixture.db
      .select({ input: actionInvocations.input })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(invocation.input).toMatchObject({ worker_cwd: '/materialized/original' });
  });

  it('refuses REST completion while a strict claim is placed but not dispatched', async () => {
    const fixture = await setup();
    const key = 'placed-before-dispatch';
    await insertStrictClaim(fixture, key);
    const placed = await placeStrictSpawn(fixture.db, {
      workspaceId: fixture.ws.workspaceId,
      invocationId: fixture.invocationId(key),
      nodeId: fixture.nodeId,
      placementToken: 'placed-before-dispatch-owner',
      reserve: true,
    });
    expect(placed).toMatchObject({
      status: 'pending',
      handlerNodeId: fixture.nodeId,
      dispatchedNodeId: null,
      dispatchAttempts: 0,
    });

    const completion = await stack.app.request(
      `/v1/actions/spawn/invocations/${fixture.invocationId(key)}/complete`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fixture.caller.token}`,
        },
        body: JSON.stringify({ output: { agent: 'forged' } }),
      },
    );
    expect(completion.status).toBe(403);
    expect(await completion.json()).toMatchObject({ error: { code: 'node_owned_invocation' } });

    const [invocation] = await fixture.db
      .select({
        status: actionInvocations.status,
        handlerNodeId: actionInvocations.handlerNodeId,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(invocation).toMatchObject({
      status: 'pending',
      handlerNodeId: fixture.nodeId,
      reservedAt: expect.any(Date),
    });
    expect(node.reservedAgents).toBe(1);
  });

  it('rejects an action-kind spawn name before placement instead of falling back to default capacity', async () => {
    const fixture = await setup();
    await fixture.db
      .update(nodeProviders)
      .set({ capabilities: [{ name: 'spawn:claude', kind: 'action' }] })
      .where(and(
        eq(nodeProviders.workspaceId, fixture.ws.workspaceId),
        eq(nodeProviders.nodeId, fixture.nodeId),
        eq(nodeProviders.name, 'default'),
      ));

    const response = await fixture.invoke('action-kind-is-not-capacity');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'capability_mismatch' } });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(0);

    const [invocation] = await fixture.db
      .select({
        handlerNodeId: actionInvocations.handlerNodeId,
        placementToken: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
        attempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('action-kind-is-not-capacity')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(invocation).toEqual({
      handlerNodeId: null,
      placementToken: null,
      reservedAt: null,
      attempts: 0,
    });
    expect(node.reservedAgents).toBe(0);
  });

  it('keeps a false-ready strict spawn in flight across empty inventory until its worker appears', async () => {
    const fixture = await setup();
    const key = 'inventory-before-worker-registration';
    const logical = { ...strictLogicalRequest(fixture.nodeId, 'strict-crash'), verify_ready: false };
    const callerNode = await attachDirectNodeSocket(stack, fixture.ws.workspaceId, fixture.caller);
    const response = await stack.app.request('/v1/actions/spawn/strict-invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.caller.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ input: strictRequestInput(logical) }),
    });
    expect(response.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);

    await fixture.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [],
    }));
    await stack.settle();

    const [inFlight] = await fixture.db
      .select({
        status: actionInvocations.status,
        reservedAt: actionInvocations.spawnReservedAt,
        attempts: actionInvocations.dispatchAttempts,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(inFlight).toEqual({
      status: 'dispatched',
      reservedAt: expect.any(Date),
      attempts: 1,
    });
    expect(deliverFramesOfType(callerNode.sock, 'action.failed')).toHaveLength(0);

    await fixture.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{
        agent_id: 'agt_inventory_after_spawn',
        name: 'worker',
        invocation_id: fixture.invocationId(key),
        session_ref: 'agent://inventory-after-spawn',
      }],
    }));
    await stack.settle();

    const [completed] = await fixture.db
      .select({ status: actionInvocations.status, reservedAt: actionInvocations.spawnReservedAt })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(completed).toEqual({ status: 'completed', reservedAt: null });
    expect(node.reservedAgents).toBe(0);
    expect(deliverFramesOfType(callerNode.sock, 'action.completed')).toHaveLength(1);
  });

  it('does not fail a claim restored after a stale dispatched recovery snapshot', async () => {
    const fixture = await setup();
    const key = 'restored-before-recovery';
    const heldAt = new Date('2026-11-10T00:00:00.000Z');
    await insertStrictClaim(fixture, key, {
      status: 'dispatched',
      handlerNodeId: fixture.nodeId,
      dispatchedNodeId: fixture.nodeId,
      dispatchedProvider: 'default',
      dispatchAttempts: 1,
      spawnReservedAt: heldAt,
      retryAfterAt: new Date('2026-11-10T00:00:30.000Z'),
    });
    await fixture.db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    const [staleDispatched] = await fixture.db
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    await restoreStrictSpawnDispatch(fixture.db, {
      workspaceId: fixture.ws.workspaceId,
      invocationId: fixture.invocationId(key),
      nodeId: fixture.nodeId,
      placementToken: 'restored-placement-owner',
      reservedAt: heldAt,
      preserveReservation: true,
    });

    expect(await rescheduleNodeInvocation(
      fixture.db,
      stack.runtime.realtime,
      staleDispatched,
    )).toBe(false);

    const [restored] = await fixture.db
      .select({
        status: actionInvocations.status,
        attempts: actionInvocations.dispatchAttempts,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        placementToken: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(restored).toEqual({
      status: 'pending',
      attempts: 0,
      dispatchedNodeId: null,
      placementToken: 'restored-placement-owner',
      reservedAt: heldAt,
    });
    expect(node.reservedAgents).toBe(1);
  });

  it('replay route returns an inserted exact-node claim without placing or dispatching it', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'replay-insert-crash');

    const response = await fixture.replay('replay-insert-crash');
    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect((await response.json() as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId('replay-insert-crash'),
      status: 'pending',
      handler_node_id: null,
      dispatched_node_id: null,
    });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(0);
    const [invocation] = await fixture.db
      .select({
        status: actionInvocations.status,
        attempts: actionInvocations.dispatchAttempts,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('replay-insert-crash')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(invocation).toEqual({
      status: 'pending',
      attempts: 0,
      token: null,
      reservedAt: null,
      dispatchedNodeId: null,
    });
    expect(node.reservedAgents).toBe(0);
  });

  it('replay route refuses a missing key without creating an invocation or reservation', async () => {
    const fixture = await setup();

    const response = await fixture.replay('replay-missing');
    expect(response.status).toBe(404);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(0);
    const [invocation] = await fixture.db
      .select({ id: actionInvocations.id })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('replay-missing')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(invocation).toBeUndefined();
    expect(node.reservedAgents).toBe(0);
  });

  it('replay route returns an existing claim without dispatching after its exact node is gone', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'replay-no-fallback');
    const alternateId = 'node_strict_alternate';
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: alternateId,
        name: 'strict-alternate',
        capabilities: ['spawn:claude'],
        max_agents: 2,
        tags: ['test'],
        version: 'test-node',
      }),
    });
    expect(created.status).toBe(201);
    const alternateSocket = new FakeSocket();
    const alternate = stack.runtime.realtime.attachNodeSocket(
      fixture.ws.workspaceId,
      alternateId,
      alternateSocket,
    );
    await alternate.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-strict-alternate',
      type: 'node.register',
      name: 'strict-alternate',
      node_id: alternateId,
      capabilities: [{ name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } }],
      max_agents: 2,
      tags: ['test'],
      version: 'test-node',
      resume_cursor: null,
    }));
    await alternate.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      active_agents: 0,
      handlers_live: true,
    }));
    await fixture.db
      .delete(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

    const response = await fixture.replay('replay-no-fallback');
    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect((await response.json() as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId('replay-no-fallback'),
      status: 'pending',
      handler_node_id: null,
      dispatched_node_id: null,
    });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(0);
    expect(alternateSocket.ofType('action.invoke')).toHaveLength(0);
    const [alternateNode] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, alternateId)));
    expect(alternateNode.reservedAgents).toBe(0);
  });

  it('replay route preserves a dispatched snapshot after its exact node is renamed', async () => {
    const fixture = await setup();
    const first = await fixture.invoke('replay-dispatched-deleted-node');
    expect(first.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await fixture.db
      .update(nodes)
      .set({ name: 'strict-crash-renamed', capabilities: [] })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

    const replay = await fixture.replay('replay-dispatched-deleted-node');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect((await replay.json() as { data: { invocation_id: string; dispatched_node_id: string } }).data)
      .toMatchObject({
        invocation_id: fixture.invocationId('replay-dispatched-deleted-node'),
        dispatched_node_id: fixture.nodeId,
      });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);

    const strictReplay = await fixture.invoke('replay-dispatched-deleted-node');
    expect(strictReplay.status).toBe(201);
    expect(strictReplay.headers.get('Idempotency-Replayed')).toBe('true');
    expect((await strictReplay.json() as { data: { invocation_id: string; dispatched_node_id: string } }).data)
      .toMatchObject({
        invocation_id: fixture.invocationId('replay-dispatched-deleted-node'),
        dispatched_node_id: fixture.nodeId,
      });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
  });

  it('claims strict spawn capacity from external liveness authority despite a stale SQL projection', async () => {
    const fixture = await setup();
    const liveSnapshot = (): NodeLivenessSnapshot => ({
      status: 'online',
      providers: [{
        name: 'default',
        connection_id: 'strict-authority',
        last_received_at: Date.now(),
        expires_at: Date.now() + 45_000,
        live: true,
        handlers_live: true,
      }],
    });
    configureNodeLiveness(fixture.db, { inspect: async () => liveSnapshot() });
    await fixture.db
      .update(nodes)
      .set({
        status: 'offline',
        handlersLive: false,
        lastHeartbeatAt: new Date(Date.now() - 300_000),
      })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

    const response = await fixture.invoke('external-liveness-stale-projection');
    expect(response.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expectSingleOwnedReservation(fixture, 'external-liveness-stale-projection');
  });

  it('releases capacity acquired by the dispatch claim when its provider send misses', async () => {
    const fixture = await setup();
    const online = (): NodeLivenessSnapshot => ({
      status: 'online',
      providers: [{
        name: 'default',
        connection_id: 'strict-readiness-transition',
        last_received_at: Date.now(),
        expires_at: Date.now() + 45_000,
        live: true,
        handlers_live: true,
      }],
    });
    let inspections = 0;
    configureNodeLiveness(fixture.db, {
      inspect: async () => inspections++ === 0
        ? { status: 'offline', providers: [] }
        : online(),
    });
    vi.spyOn(stack.runtime.realtime, 'sendToProvider').mockResolvedValueOnce(false);

    const response = await fixture.invoke('claim-acquired-reservation-send-miss');
    expect(response.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toEqual([]);
    const [invocation] = await fixture.db
      .select({
        status: actionInvocations.status,
        attempts: actionInvocations.dispatchAttempts,
        reservedAt: actionInvocations.spawnReservedAt,
        placementToken: actionInvocations.spawnPlacementToken,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('claim-acquired-reservation-send-miss')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(invocation).toMatchObject({
      status: 'pending',
      attempts: 0,
      reservedAt: null,
      placementToken: expect.any(String),
    });
    expect(node.reservedAgents).toBe(0);
  });

  it.each(['completed', 'failed'] as const)(
    'strict-invoke replay preserves the durable %s status',
    async (status) => {
      const fixture = await setup();
      const first = await fixture.invoke(`terminal-${status}`);
      expect(first.status).toBe(201);
      await fixture.db
        .update(actionInvocations)
        .set({
          status,
          completedAt: new Date(),
          ...(status === 'failed' ? { error: 'agent_failed' } : { output: { ok: true } }),
        })
        .where(eq(actionInvocations.id, fixture.invocationId(`terminal-${status}`)));
      await fixture.db
        .update(nodes)
        .set({ name: 'strict-crash-renamed', capabilities: [] })
        .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

      const replay = await fixture.invoke(`terminal-${status}`);
      expect(replay.status).toBe(201);
      expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
      expect((await replay.json() as { data: { status: string } }).data.status).toBe(status);
      expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    },
  );

  it('stamps a fresh dispatch timeout when resuming a reserved definitely-unsent claim', async () => {
    const fixture = await setup();
    const heldAt = new Date(Date.now() - ACTION_DISPATCH_TIMEOUT_MS - 1_000);
    await insertStrictClaim(fixture, 'reserved-crash', {
      handlerNodeId: fixture.nodeId,
      spawnPlacementToken: 'placement-owner',
      spawnReservedAt: heldAt,
      handlerUnreachableSince: heldAt,
    });
    await fixture.db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    const [persistedReservation] = await fixture.db
      .select({ reservedAt: actionInvocations.spawnReservedAt })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('reserved-crash')));

    const dispatchStartedAt = Date.now();
    const response = await fixture.invoke('reserved-crash');
    expect(response.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expectSingleOwnedReservation(fixture, 'reserved-crash');
    const [dispatched] = await fixture.db
      .select({
        status: actionInvocations.status,
        dispatchedAt: actionInvocations.dispatchedAt,
        retryAfterAt: actionInvocations.retryAfterAt,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('reserved-crash')));
    expect(dispatched.reservedAt).toEqual(persistedReservation.reservedAt);
    // SQLite stores timestamps to whole seconds; the dispatch claim must still
    // be fresh rather than inheriting the much older reservation timestamp.
    expect(dispatched.dispatchedAt?.getTime()).toBeGreaterThanOrEqual(dispatchStartedAt - 1_000);
    expect(dispatched.retryAfterAt?.getTime()).toBeGreaterThan(dispatched.dispatchedAt?.getTime() ?? 0);

    await sweepTimedOutInvocations(fixture.db, stack.runtime.realtime, {
      timeoutMs: ACTION_DISPATCH_TIMEOUT_MS,
    });
    const [afterSweep] = await fixture.db
      .select({ status: actionInvocations.status, reservedAt: actionInvocations.spawnReservedAt })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('reserved-crash')));
    expect(afterSweep).toEqual({ status: 'dispatched', reservedAt: persistedReservation.reservedAt });
  });

  it('replay route returns a reserved definitely-unsent claim without dispatching it', async () => {
    const fixture = await setup();
    const heldAt = new Date(Date.now() - 1_000);
    await insertStrictClaim(fixture, 'replay-reserved-crash', {
      handlerNodeId: fixture.nodeId,
      spawnPlacementToken: 'replay-placement-owner',
      spawnReservedAt: heldAt,
      handlerUnreachableSince: heldAt,
    });
    await fixture.db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    const [persistedReservation] = await fixture.db
      .select({ reservedAt: actionInvocations.spawnReservedAt })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('replay-reserved-crash')));

    const response = await fixture.replay('replay-reserved-crash');
    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect((await response.json() as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId('replay-reserved-crash'),
      status: 'pending',
      handler_node_id: fixture.nodeId,
      dispatched_node_id: null,
    });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(0);
    const [invocation] = await fixture.db
      .select({
        status: actionInvocations.status,
        attempts: actionInvocations.dispatchAttempts,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('replay-reserved-crash')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(invocation).toEqual({
      status: 'pending',
      attempts: 0,
      token: 'replay-placement-owner',
      reservedAt: persistedReservation.reservedAt,
      dispatchedNodeId: null,
    });
    expect(node.reservedAgents).toBe(1);
  });

  it('rolls back placement when the exact node vanished before reservation', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'deleted-node-race');
    await fixture.db
      .delete(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

    const placed = await placeStrictSpawn(fixture.db, {
      workspaceId: fixture.ws.workspaceId,
      invocationId: fixture.invocationId('deleted-node-race'),
      nodeId: fixture.nodeId,
      placementToken: 'must-not-commit',
      reserve: true,
    });

    expect(placed).toBeUndefined();
    const [row] = await fixture.db
      .select({
        handlerNodeId: actionInvocations.handlerNodeId,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('deleted-node-race')));
    expect(row).toEqual({ handlerNodeId: null, token: null, reservedAt: null });
  });

  it('lets one concurrent retry own placement, capacity, and the provider frame', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'concurrent-crash');

    const responses = await Promise.all([
      fixture.invoke('concurrent-crash'),
      fixture.invoke('concurrent-crash'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expectSingleOwnedReservation(fixture, 'concurrent-crash');
  });

  it('does not resend after a crash with an unknown socket-send outcome', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'unknown-send');
    const realtime = stack.runtime.realtime;
    const send = realtime.sendToProvider.bind(realtime);
    vi.spyOn(realtime, 'sendToProvider').mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new Error('process died after socket accepted the frame');
    });

    expect((await fixture.invoke('unknown-send')).status).toBe(201);
    const callerNode = await attachDirectNodeSocket(stack, fixture.ws.workspaceId, fixture.caller);
    expect((await fixture.invoke('unknown-send')).status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    const [row] = await fixture.db
      .select({
        token: actionInvocations.spawnPlacementToken,
        attempts: actionInvocations.dispatchAttempts,
        nodeId: actionInvocations.dispatchedNodeId,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('unknown-send')));
    expect(row).toEqual({ token: null, attempts: 1, nodeId: fixture.nodeId });

    const sweep = () => sweepTimedOutInvocations(fixture.db, stack.runtime.realtime, {
      timeoutMs: 0,
      completionDeps: stack.runtime.deps,
    });
    await sweep();
    await sweep();
    await stack.settle();
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    const failed = deliverFramesOfType(callerNode.sock, 'action.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId('unknown-send'),
      error: 'handler_unavailable',
    });
    const [settled] = await fixture.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('unknown-send')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(settled).toEqual({ status: 'failed', error: 'handler_unavailable', reservedAt: null });
    expect(node.reservedAgents).toBe(0);
  });

  it('settles an indeterminate strict send instead of detaching it on node loss', async () => {
    const fixture = await setup();
    await insertStrictClaim(fixture, 'unknown-send-node-loss');
    const realtime = stack.runtime.realtime;
    const send = realtime.sendToProvider.bind(realtime);
    vi.spyOn(realtime, 'sendToProvider').mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new Error('process died after socket accepted the frame');
    });
    expect((await fixture.invoke('unknown-send-node-loss')).status).toBe(201);
    const callerNode = await attachDirectNodeSocket(stack, fixture.ws.workspaceId, fixture.caller);
    const [before] = await fixture.db
      .select({ revision: actionInvocations.nodeLivenessRevision })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('unknown-send-node-loss')));

    const detached = await detachInvocationsFromLostNode(
      fixture.db,
      fixture.ws.workspaceId,
      fixture.nodeId,
      { claimRevision: before.revision + 1, completionDeps: stack.runtime.deps },
    );
    await stack.settle();
    expect(detached).toBe(0);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    const [settled] = await fixture.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('unknown-send-node-loss')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(settled).toEqual({ status: 'failed', error: 'handler_unavailable', reservedAt: null });
    expect(node.reservedAgents).toBe(0);
    const failed = deliverFramesOfType(callerNode.sock, 'action.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId('unknown-send-node-loss'),
      error: 'handler_unavailable',
    });
  });

  it('emits action.failed once when offline settlement closes a strict send', async () => {
    const fixture = await setup();
    const key = 'unknown-send-offline-settlement';
    expect((await fixture.invoke(key)).status).toBe(201);
    const callerNode = await attachDirectNodeSocket(stack, fixture.ws.workspaceId, fixture.caller);

    const settle = () => settleNodeOffline(
      fixture.db,
      stack.runtime.realtime,
      fixture.ws.workspaceId,
      fixture.nodeId,
      { deps: stack.runtime.deps },
    );
    await settle();
    await settle();
    await stack.settle();

    const failed = deliverFramesOfType(callerNode.sock, 'action.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId(key),
      error: 'handler_unavailable',
    });
    const [row] = await fixture.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(row).toEqual({ status: 'failed', error: 'handler_unavailable' });
  });

  it('keeps an indeterminate strict send closed to retry when node-loss settlement fails', async () => {
    const fixture = await setup();
    const key = 'node-loss-settlement-write-failure';
    expect((await fixture.invoke(key)).status).toBe(201);
    const restore = injectUpdateFailure(
      fixture.db,
      actionInvocations,
      'injected exact strict settlement failure',
      { times: 1 },
    );

    expect(await rescheduleInvocationsForLostNode(
      fixture.db,
      stack.runtime.realtime,
      fixture.ws.workspaceId,
      fixture.nodeId,
    )).toBe(0);
    restore();

    const [row] = await fixture.db
      .select({
        status: actionInvocations.status,
        attempts: actionInvocations.dispatchAttempts,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(row).toEqual({
      status: 'dispatched',
      attempts: 1,
      dispatchedNodeId: fixture.nodeId,
      reservedAt: expect.any(Date),
    });
    expect(node.reservedAgents).toBe(1);

    const replay = await fixture.invoke(key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
  });

  it('does not fail a newer strict redispatch restored after the detach snapshot', async () => {
    if (conformancePgDb()) return;
    const fixture = await setup();
    const key = 'restored-before-detach';
    const heldAt = new Date('2026-11-10T00:00:00.000Z');
    const firstDispatchedAt = new Date('2026-11-10T00:00:01.000Z');
    await insertStrictClaim(fixture, key, {
      status: 'dispatched',
      handlerNodeId: fixture.nodeId,
      dispatchedNodeId: fixture.nodeId,
      dispatchedProvider: 'default',
      dispatchAttempts: 1,
      spawnDispatchGeneration: 1,
      dispatchedAt: firstDispatchedAt,
      spawnReservedAt: heldAt,
      retryAfterAt: new Date('2026-11-10T00:00:30.000Z'),
    });
    await fixture.db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    const [beforeDetach] = await fixture.db
      .select({ revision: actionInvocations.nodeLivenessRevision })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('restored-before-detach')));

    vi.useFakeTimers();
    vi.setSystemTime(firstDispatchedAt);
    let restoredDuringDetach = false;
    try {
      attachFakeBatch(stack, fixture.db, async () => {
        if (restoredDuringDetach) return;
        restoredDuringDetach = true;
        await restoreStrictSpawnDispatch(fixture.db, {
          workspaceId: fixture.ws.workspaceId,
          invocationId: fixture.invocationId(key),
          nodeId: fixture.nodeId,
          placementToken: 'restored-detach-owner',
          reservedAt: heldAt,
          preserveReservation: true,
        });
        const claimed = await claimStrictSpawnDispatch(fixture.db, {
          workspaceId: fixture.ws.workspaceId,
          invocationId: fixture.invocationId(key),
          nodeId: fixture.nodeId,
          providerName: 'default',
          placementToken: 'restored-detach-owner',
          reservationHeldAt: heldAt,
          dispatchTimeoutMs: ACTION_DISPATCH_TIMEOUT_MS,
        });
        expect(claimed.claimed).toBe(true);
      });

      expect(await detachInvocationsFromLostNode(
        fixture.db,
        fixture.ws.workspaceId,
        fixture.nodeId,
        { claimRevision: beforeDetach.revision + 1 },
      )).toBe(0);
      expect(restoredDuringDetach).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const [restored] = await fixture.db
      .select({
        status: actionInvocations.status,
        attempts: actionInvocations.dispatchAttempts,
        dispatchedNodeId: actionInvocations.dispatchedNodeId,
        placementToken: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
        dispatchedAt: actionInvocations.dispatchedAt,
        generation: actionInvocations.spawnDispatchGeneration,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(restored).toEqual({
      status: 'dispatched',
      attempts: 1,
      dispatchedNodeId: fixture.nodeId,
      placementToken: null,
      reservedAt: heldAt,
      dispatchedAt: firstDispatchedAt,
      generation: 2,
    });
    expect(node.reservedAgents).toBe(1);

    const [current] = await fixture.db
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(await rescheduleNodeInvocation(fixture.db, stack.runtime.realtime, current)).toBe(false);
    const [failed] = await fixture.db
      .select({ status: actionInvocations.status, reservedAt: actionInvocations.spawnReservedAt })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    const [released] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(failed).toEqual({ status: 'failed', reservedAt: null });
    expect(released.reservedAgents).toBe(0);
  });

  it('emits action.failed when a strict provider reports handler_unavailable', async () => {
    const fixture = await setup();
    const callerNode = await attachDirectNodeSocket(stack, fixture.ws.workspaceId, fixture.caller);
    const key = 'provider-failure-notification';
    const response = await fixture.invoke(key);
    expect(response.status).toBe(201);

    await fixture.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'provider-failure-result',
      type: 'action.result',
      invocation_id: fixture.invocationId(key),
      error: 'handler_unavailable',
    }));
    await stack.settle();

    const failed = deliverFramesOfType(callerNode.sock, 'action.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { data: Record<string, unknown> }).data).toMatchObject({
      invocation_id: fixture.invocationId(key),
      error: 'handler_unavailable',
    });
    const [row] = await fixture.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId(key)));
    expect(row).toEqual({ status: 'failed', error: 'handler_unavailable' });
  });

  it('expires a reserved unsent claim and releases its slot exactly once', async () => {
    const fixture = await setup();
    const heldAt = new Date(Date.now() - 5_000);
    await insertStrictClaim(fixture, 'expired-reservation', {
      handlerNodeId: fixture.nodeId,
      spawnPlacementToken: 'expired-placement-owner',
      spawnReservedAt: heldAt,
      handlerUnreachableSince: heldAt,
      createdAt: heldAt,
    });
    await fixture.db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

    const sweep = () => sweepTimedOutInvocations(fixture.db, stack.runtime.realtime, {
      pendingInvocationMaxAgeMs: 0,
      neverDispatchedSweepGraceMs: 0,
    });
    await sweep();
    await sweep();

    const [row] = await fixture.db
      .select({
        status: actionInvocations.status,
        error: actionInvocations.error,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('expired-reservation')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(row).toEqual({
      status: 'failed',
      error: 'never_dispatched_expired',
      token: null,
      reservedAt: null,
    });
    expect(node.reservedAgents).toBe(0);
  });

  it('does not clear a reservation acquired after the expiry snapshot', async () => {
    if (conformancePgDb()) return;
    const fixture = await setup();
    const heldAt = new Date(Date.now() - 5_000);
    await insertStrictClaim(fixture, 'expiry-held-first', {
      handlerNodeId: fixture.nodeId,
      spawnPlacementToken: 'first-expiry-owner',
      spawnReservedAt: heldAt,
      handlerUnreachableSince: heldAt,
      createdAt: heldAt,
    });
    await insertStrictClaim(fixture, 'expiry-race', { createdAt: heldAt });
    await fixture.db
      .update(nodes)
      .set({ reservedAgents: 1 })
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));

    let raced = false;
    attachFakeBatch(stack, fixture.db, async () => {
      if (raced) return;
      raced = true;
      const placed = await placeStrictSpawn(fixture.db, {
        workspaceId: fixture.ws.workspaceId,
        invocationId: fixture.invocationId('expiry-race'),
        nodeId: fixture.nodeId,
        placementToken: 'racing-expiry-owner',
        reserve: true,
      });
      expect(placed?.spawnReservedAt).toBeInstanceOf(Date);
    });

    const sweep = () => sweepTimedOutInvocations(fixture.db, stack.runtime.realtime, {
      pendingInvocationMaxAgeMs: 0,
      neverDispatchedSweepGraceMs: 0,
    });
    await sweep();
    expect(raced).toBe(true);
    const [stillOwned] = await fixture.db
      .select({
        status: actionInvocations.status,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('expiry-race')));
    const [afterRace] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(stillOwned).toMatchObject({ status: 'pending', token: 'racing-expiry-owner' });
    expect(stillOwned.reservedAt).toBeInstanceOf(Date);
    expect(afterRace.reservedAgents).toBe(1);

    await sweep();
    const [expired] = await fixture.db
      .select({
        status: actionInvocations.status,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('expiry-race')));
    const [released] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(expired).toEqual({ status: 'failed', token: null, reservedAt: null });
    expect(released.reservedAgents).toBe(0);
  });

  it('rolls back handler snapshot and reservation when a D1 batch statement fails', async () => {
    if (conformancePgDb()) return;
    const fixture = await setup();
    await insertStrictClaim(fixture, 'd1-batch-crash');
    attachFakeBatch(stack, fixture.db);
    const restore = injectUpdateFailure(fixture.db, nodes, 'injected D1 reservation failure');

    expect((await fixture.invoke('d1-batch-crash')).status).toBe(500);
    restore();
    const [row] = await fixture.db
      .select({
        handlerNodeId: actionInvocations.handlerNodeId,
        token: actionInvocations.spawnPlacementToken,
        reservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, fixture.invocationId('d1-batch-crash')));
    const [node] = await fixture.db
      .select({ reservedAgents: nodes.reservedAgents })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
    expect(row).toEqual({ handlerNodeId: null, token: null, reservedAt: null });
    expect(node.reservedAgents).toBe(0);

    expect((await fixture.invoke('d1-batch-crash')).status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
  });

  async function setup() {
    const ws = await createWorkspace(stack.app, `strict-crash-${Math.random()}`);
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    const nodeId = 'node_strict_crash';
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: nodeId,
        name: 'strict-crash',
        capabilities: ['spawn:claude'],
        max_agents: 2,
        tags: ['test'],
        version: 'test-node',
      }),
    });
    expect(created.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-strict-crash',
      type: 'node.register',
      name: 'strict-crash',
      node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'spawn', metadata: { agent: 'claude' } }],
      max_agents: 2,
      tags: ['test'],
      version: 'test-node',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      active_agents: 0,
      handlers_live: true,
    }));
    await stack.settle();

    const logical = strictLogicalRequest(nodeId, 'strict-crash');
    const storedInput = strictStoredInput(logical);
    const invocationId = (key: string) => strictInvocationId(ws.workspaceId, caller.agentId, key);
    const invoke = (key: string, workerCwd = '/materialized/repo') => stack.app.request('/v1/actions/spawn/strict-invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ input: strictRequestInput(logical, workerCwd) }),
    });
    const replay = (key: string) => stack.app.request('/v1/actions/spawn/replay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ logical_request: logical }),
    });
    return {
      ws,
      caller,
      nodeId,
      sock,
      handle,
      db: stack.runtime.deps.db,
      storedInput,
      invocationId,
      invoke,
      replay,
    };
  }
});

interface StrictFixture {
  ws: { workspaceId: string; workspaceKey: string };
  caller: { agentId: string; name: string; token: string };
  nodeId: string;
  sock: FakeSocket;
  handle: { handleMessage(data: string): Promise<void> };
  db: EngineDb;
  storedInput: Record<string, unknown>;
  invocationId(key: string): string;
  invoke(key: string, workerCwd?: string): Promise<Response>;
  replay(key: string): Promise<Response>;
}

async function insertStrictClaim(
  fixture: StrictFixture,
  key: string,
  state: Partial<typeof actionInvocations.$inferInsert> = {},
): Promise<void> {
  await fixture.db.insert(actionInvocations).values({
    id: fixture.invocationId(key),
    workspaceId: fixture.ws.workspaceId,
    actionName: 'spawn',
    invocationOrigin: 'builtin',
    callerId: fixture.caller.agentId,
    callerName: fixture.caller.name,
    input: fixture.storedInput,
    status: 'pending',
    ...state,
  });
}

async function expectSingleOwnedReservation(fixture: StrictFixture, key: string): Promise<void> {
  const [node] = await fixture.db
    .select({ reservedAgents: nodes.reservedAgents })
    .from(nodes)
    .where(and(eq(nodes.workspaceId, fixture.ws.workspaceId), eq(nodes.id, fixture.nodeId)));
  expect(node.reservedAgents).toBe(1);
  const [invocation] = await fixture.db
    .select({
      token: actionInvocations.spawnPlacementToken,
      reservedAt: actionInvocations.spawnReservedAt,
      attempts: actionInvocations.dispatchAttempts,
      nodeId: actionInvocations.dispatchedNodeId,
    })
    .from(actionInvocations)
    .where(eq(actionInvocations.id, fixture.invocationId(key)));
  expect(invocation.token).toBeNull();
  expect(invocation.reservedAt).toBeInstanceOf(Date);
  expect(invocation.attempts).toBe(1);
  expect(invocation.nodeId).toBe(fixture.nodeId);
}
