import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { actionInvocations, nodes } from '../../db/tables.js';
import type { EngineDb } from '../../ports/database.js';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

const legacySchema = 'relay.spawn.invoke.logical/1';
const replayResumeSchema = 'relay.spawn.invoke.logical-replay-resume/1';
const replayResumeCapability = 'relay.spawn.replay-resume/1';

describe('strict spawn replay-resume capability', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack({ ttlMs: 60_000 });
  });
  afterEach(() => stack.close());

  it('resumes a marked pre-dispatch claim from its persisted task and cwd', async () => {
    const fixture = await setup();
    const key = 'marked-resume';
    await fixture.insert(key);

    const response = await fixture.replay(key);

    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    await expect(response.json()).resolves.toMatchObject({
      data: {
        invocation_id: fixture.invocationId(key),
        spawn_contract_applied: replayResumeSchema,
        spawn_replay_capability_applied: replayResumeCapability,
      },
    });
    expect(fixture.sock.ofType('action.invoke')).toEqual([
      expect.objectContaining({
        invocation_id: fixture.invocationId(key),
        action: 'spawn:claude',
        input: expect.objectContaining({
          task: 'persisted replay task',
          worker_cwd: '/persisted/materialized/repo',
        }),
      }),
    ]);
  });

  it('returns both proofs when strict-invoke accepts the opt-in schema', async () => {
    const fixture = await setup();

    const response = await fixture.invoke('new-contract');

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        spawn_contract_applied: replayResumeSchema,
        spawn_replay_capability_applied: replayResumeCapability,
      },
    });
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
  });

  it('keeps logical/1 and unmarked successor claims lookup-only or fail-closed', async () => {
    const fixture = await setup();
    const legacyKey = 'legacy-lookup';
    const legacyLogical = fixture.logical(legacySchema);
    await fixture.insert(legacyKey, {
      input: fixture.storedInput(legacyLogical, false),
    });

    const legacy = await fixture.replay(legacyKey, legacyLogical);
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toMatchObject({
      data: { spawn_contract_applied: legacySchema },
    });
    expect(fixture.sock.ofType('action.invoke')).toEqual([]);

    const unmarkedKey = 'unmarked-successor';
    await fixture.insert(unmarkedKey, {
      input: {
        ...fixture.requestInput(fixture.logical()),
        spawn_contract_applied: replayResumeSchema,
      },
    });
    const unmarked = await fixture.replay(unmarkedKey);
    expect(unmarked.status).toBe(400);
    expect(fixture.sock.ofType('action.invoke')).toEqual([]);
  });

  it('rejects caller-forged replay proof before creating a claim', async () => {
    const fixture = await setup();
    const key = 'forged-proof';
    const response = await fixture.invoke(key, {
      ...fixture.requestInput(fixture.logical()),
      spawn_replay_capability_applied: replayResumeCapability,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_spawn_request' },
    });
    expect(await fixture.invocations(key)).toEqual([]);
    expect(fixture.sock.ofType('action.invoke')).toEqual([]);

    const replayForgery = await stack.app.request('/v1/actions/spawn/replay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.caller.token}`,
        'Idempotency-Key': 'forged-replay-proof',
      },
      body: JSON.stringify({
        logical_request: fixture.logical(),
        spawn_replay_capability_applied: replayResumeCapability,
      }),
    });
    expect(replayForgery.status).toBe(400);
    expect(await fixture.invocations('forged-replay-proof')).toEqual([]);
  });

  it('never creates or falls back when caller, key, request, or target does not match', async () => {
    const fixture = await setup();
    const shadow = await registerAgent(
      stack.app,
      fixture.ws.workspaceKey,
      'shadow-spawn',
    );
    const registered = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${fixture.ws.workspaceKey}`,
      },
      body: JSON.stringify({
        name: 'spawn',
        description: 'must never handle replay-resume',
        handler_agent: shadow.name,
      }),
    });
    expect(registered.status).toBe(201);

    expect((await fixture.replay('missing')).status).toBe(404);
    expect(await fixture.invocations('missing')).toEqual([]);

    const key = 'isolated';
    await fixture.insert(key);
    const other = await registerAgent(
      stack.app,
      fixture.ws.workspaceKey,
      'other-replay-caller',
    );
    expect(
      (await fixture.replay(key, fixture.logical(), other.token)).status,
    ).toBe(404);
    expect(
      (await fixture.replay(key, { ...fixture.logical(), task: 'other task' }))
        .status,
    ).toBe(409);

    await fixture.db
      .update(nodes)
      .set({ name: 'renamed-after-claim' })
      .where(
        and(
          eq(nodes.workspaceId, fixture.ws.workspaceId),
          eq(nodes.id, fixture.nodeId),
        ),
      );
    expect((await fixture.replay(key)).status).toBe(409);
    expect(fixture.sock.ofType('action.invoke')).toEqual([]);
    expect(await fixture.invocations(key)).toHaveLength(1);
  });

  it('lets one concurrent replay own one frame, slot, and dispatch generation', async () => {
    const fixture = await setup();
    const key = 'concurrent-replay-resume';
    await fixture.insert(key);

    const responses = await Promise.all([
      fixture.replay(key),
      fixture.replay(key),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expect(fixture.dispatchState(key)).resolves.toMatchObject({
      attempts: 1,
      generation: 1,
      nodeId: fixture.nodeId,
      reservedAgents: 1,
    });
  });

  it('does not resend a marked claim after an unknown socket-send outcome', async () => {
    const fixture = await setup();
    const key = 'unknown-send-replay-resume';
    await fixture.insert(key);
    const registry = stack.runtime.realtime;
    const send = registry.sendToProvider.bind(registry);
    const sendSpy = vi
      .spyOn(registry, 'sendToProvider')
      .mockImplementationOnce(async (...args) => {
        await send(...args);
        throw new Error(
          'socket accepted frame before transport outcome was lost',
        );
      });

    expect((await fixture.replay(key)).status).toBe(200);
    expect((await fixture.replay(key)).status).toBe(200);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expect(fixture.dispatchState(key)).resolves.toMatchObject({
      attempts: 1,
      generation: 1,
      nodeId: fixture.nodeId,
      reservedAgents: 1,
    });
  });

  it('returns a terminal marked snapshot without another provider send', async () => {
    const fixture = await setup();
    const key = 'terminal-replay-resume';
    await fixture.insert(key, {
      status: 'completed',
      handlerNodeId: fixture.nodeId,
      dispatchedNodeId: fixture.nodeId,
      dispatchAttempts: 1,
      spawnDispatchGeneration: 1,
      completedAt: new Date(),
      output: { agent: 'already-finished' },
    });

    const response = await fixture.replay(key);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        status: 'completed',
        spawn_contract_applied: replayResumeSchema,
        spawn_replay_capability_applied: replayResumeCapability,
      },
    });
    expect(fixture.sock.ofType('action.invoke')).toEqual([]);
  });

  it('fences a restored send attempt with a fresh generation without leaking its slot', async () => {
    const fixture = await setup();
    const key = 'restored-generation';
    await fixture.insert(key);
    const registry = stack.runtime.realtime;
    const send = registry.sendToProvider.bind(registry);
    vi.spyOn(registry, 'sendToProvider')
      .mockResolvedValueOnce(false)
      .mockImplementation((...args) => send(...args));

    expect((await fixture.replay(key)).status).toBe(200);
    await expect(fixture.dispatchState(key)).resolves.toMatchObject({
      attempts: 0,
      generation: 1,
      nodeId: null,
      reservedAgents: 1,
    });

    expect((await fixture.replay(key)).status).toBe(200);
    expect(fixture.sock.ofType('action.invoke')).toHaveLength(1);
    await expect(fixture.dispatchState(key)).resolves.toMatchObject({
      attempts: 1,
      generation: 2,
      nodeId: fixture.nodeId,
      reservedAgents: 1,
    });
  });

  async function setup() {
    const ws = await createWorkspace(
      stack.app,
      `strict-replay-resume-${Math.random()}`,
    );
    const caller = await registerAgent(
      stack.app,
      ws.workspaceKey,
      'replay-resume-caller',
    );
    const nodeId = 'node_replay_resume';
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        node_id: nodeId,
        name: 'replay-resume-node',
        capabilities: ['spawn:claude'],
        max_agents: 2,
        tags: ['test'],
        version: 'test-node',
      }),
    });
    expect(created.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(
      ws.workspaceId,
      nodeId,
      sock,
    );
    await handle.handleMessage(
      JSON.stringify({
        v: 1,
        id: 'register-replay-resume',
        type: 'node.register',
        name: 'replay-resume-node',
        node_id: nodeId,
        capabilities: [
          {
            name: 'spawn:claude',
            kind: 'spawn',
            metadata: { agent: 'claude' },
          },
        ],
        max_agents: 2,
        tags: ['test'],
        version: 'test-node',
        resume_cursor: null,
      }),
    );
    await handle.handleMessage(
      JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        active_agents: 0,
        handlers_live: true,
      }),
    );
    await stack.settle();
    const db = stack.runtime.deps.db;
    const logical = (schema = replayResumeSchema) => ({
      schema,
      target_node_id: nodeId,
      target_node: 'replay-resume-node',
      name: 'worker',
      cli: 'claude',
      task: 'persisted replay task',
      directory: '/requested/repo',
      verify_ready: true,
    });
    const requestInput = (request: ReturnType<typeof logical>) => ({
      spawn_contract: request.schema,
      target_node_id: request.target_node_id,
      target_node: request.target_node,
      name: request.name,
      cli: request.cli,
      task: request.task,
      worker_cwd: '/persisted/materialized/repo',
      verify_ready: request.verify_ready,
      logical_request: request,
    });
    const storedInput = (request = logical(), replayCapable = true) => ({
      ...requestInput(request),
      spawn_contract_applied: request.schema,
      ...(replayCapable
        ? { spawn_replay_capability_applied: replayResumeCapability }
        : {}),
    });
    const invocationId = (key: string, callerId = caller.agentId) =>
      `inv_idem_${createHash('sha256')
        .update(
          ['action-invoke-v1', ws.workspaceId, callerId, 'spawn', key].join(
            '\0',
          ),
        )
        .digest('hex')}`;
    const insert = async (
      key: string,
      state: Partial<typeof actionInvocations.$inferInsert> = {},
    ) => {
      await db.insert(actionInvocations).values({
        id: invocationId(key),
        workspaceId: ws.workspaceId,
        actionName: 'spawn',
        invocationOrigin: 'builtin',
        callerId: caller.agentId,
        callerName: caller.name,
        input: storedInput(),
        status: 'pending',
        ...state,
      });
    };
    const replay = (key: string, request = logical(), token = caller.token) =>
      stack.app.request('/v1/actions/spawn/replay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ logical_request: request }),
      });
    const invoke = (
      key: string,
      input: Record<string, unknown> = requestInput(logical()),
    ) =>
      stack.app.request('/v1/actions/spawn/strict-invoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${caller.token}`,
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ input }),
      });
    const invocations = (key: string) =>
      db
        .select({ id: actionInvocations.id })
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId(key)));
    const dispatchState = async (key: string) => {
      const [invocation] = await db
        .select({
          attempts: actionInvocations.dispatchAttempts,
          generation: actionInvocations.spawnDispatchGeneration,
          nodeId: actionInvocations.dispatchedNodeId,
        })
        .from(actionInvocations)
        .where(eq(actionInvocations.id, invocationId(key)));
      const [node] = await db
        .select({ reservedAgents: nodes.reservedAgents })
        .from(nodes)
        .where(
          and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId)),
        );
      return { ...invocation, reservedAgents: node.reservedAgents };
    };
    return {
      ws,
      caller,
      nodeId,
      sock,
      db: db as EngineDb,
      logical,
      requestInput,
      storedInput,
      invocationId,
      insert,
      replay,
      invoke,
      invocations,
      dispatchState,
    };
  }
});
