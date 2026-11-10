import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { actionInvocations, nodes } from '../../db/tables.js';
import type { EngineDb } from '../../ports/database.js';
import { sweepTimedOutInvocations } from '../../engine/action.js';
import {
  attachFakeBatch,
  createWorkspace,
  FakeSocket,
  injectUpdateFailure,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { conformancePgDb } from './pgMode.js';

const schema = 'relay.spawn.invoke.logical/1';

describe('strict spawn crash recovery', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

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

  it('resumes a reserved definitely-unsent claim without taking a second slot', async () => {
    const fixture = await setup();
    const heldAt = new Date(Date.now() - 1_000);
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

    const response = await fixture.invoke('reserved-crash');
    expect(response.status).toBe(201);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expectSingleOwnedReservation(fixture, 'reserved-crash');
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

    const logical = {
      schema,
      target_node_id: nodeId,
      target_node: 'strict-crash',
      name: 'worker',
      cli: 'claude',
      task: 'prove crash recovery',
      directory: '/repo',
      verify_ready: true,
    };
    const requestInput = {
      spawn_contract: schema,
      target_node_id: logical.target_node_id,
      target_node: logical.target_node,
      name: logical.name,
      cli: logical.cli,
      task: logical.task,
      worker_cwd: '/materialized/repo',
      verify_ready: logical.verify_ready,
      logical_request: logical,
    };
    const storedInput = { ...requestInput, spawn_contract_applied: schema };
    const invocationId = (key: string) => `inv_idem_${createHash('sha256')
      .update(['action-invoke-v1', ws.workspaceId, caller.agentId, 'spawn', key].join('\0'))
      .digest('hex')}`;
    const invoke = (key: string) => stack.app.request('/v1/actions/spawn/strict-invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${caller.token}`,
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ input: requestInput }),
    });
    return {
      ws,
      caller,
      nodeId,
      sock,
      db: stack.runtime.deps.db,
      storedInput,
      invocationId,
      invoke,
    };
  }
});

interface StrictFixture {
  ws: { workspaceId: string; workspaceKey: string };
  caller: { agentId: string; name: string };
  nodeId: string;
  sock: FakeSocket;
  db: EngineDb;
  storedInput: Record<string, unknown>;
  invocationId(key: string): string;
  invoke(key: string): Promise<Response>;
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
