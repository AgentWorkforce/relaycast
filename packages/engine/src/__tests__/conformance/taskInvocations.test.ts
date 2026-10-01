import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FleetActionInvokeMessage, FleetActionAcceptMessage, FleetActionResultMessage } from '@relaycast/types';
import { makeNodeStack, createWorkspace, registerAgent, FakeSocket, type TestStack } from './harness.js';
import { actionInvocations } from '../../db/schema.js';
import { getSqliteDb } from '../../adapters/node/database.js';
import { acceptTaskInvocation, completeTaskInvocation } from '../../engine/taskInvocation.js';
import { getInvocation, rescheduleNodeInvocation, rescheduleInvocationsForLostNode, sweepTimedOutInvocations } from '../../engine/action.js';

describe('durable task invocations', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await stack.close(); });

  async function setup(timeoutMs = 120_000) {
    const ws = await createWorkspace(stack.app, 'tasks');
    const caller = await registerAgent(stack.app, ws.workspaceKey, 'caller');
    expect((await stack.app.request('/v1/nodes', {
      method: 'POST', headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: 'node_a', name: 'alpha', role: 'broker', capabilities: [], max_agents: 4, tags: [], version: 'v1' }),
    })).status).toBe(201);
    async function attach() {
      const sock = new FakeSocket();
      const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_a', sock);
      await handle.handleMessage(JSON.stringify({
        v: 1, id: 'register', type: 'node.register', node_id: 'node_a', name: 'alpha',
        capabilities: [{ name: 'task.run', kind: 'action', execution_mode: 'task', global: true }, { name: 'echo', kind: 'action', global: true }],
        max_agents: 4, tags: [], version: 'v1', resume_cursor: null,
      }));
      expect(sock.ofType('reply').at(-1)).toMatchObject({ ok: true });
      await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', active_agents: 0, handlers_live: true }));
      return { sock, handle };
    }
    const connection = await attach();
    const input = { task: 'Return an answer', task_context: { run_id: 'run-1', step_id: 'step-1', dispatch_id: 'dispatch-1', timeout_ms: timeoutMs } };
    const invoke = (key: string | null = 'key-1', value: object = input, path = '/v1/actions/task.run/invoke') => stack.app.request(path, {
      method: 'POST', headers: { authorization: `Bearer ${caller.token}`, 'content-type': 'application/json', ...(key === null ? {} : { 'Idempotency-Key': key }) },
      body: JSON.stringify({ input: value }),
    });
    const read = async (id: string) => {
      const response = await stack.app.request(`/v1/actions/task.run/invocations/${id}`, { headers: { authorization: `Bearer ${caller.token}` } });
      expect(response.status).toBe(200);
      return (await response.json()).data;
    };
    const start = async () => {
      const response = await invoke();
      expect(response.status).toBe(201);
      const id = (await response.json()).data.invocation_id as string;
      const frame = connection.sock.ofType('action.invoke').at(-1) as FleetActionInvokeMessage;
      expect(frame.task_execution).toMatchObject({ execution_id: `${id}/1`, run_id: 'run-1', step_id: 'step-1', dispatch_id: 'dispatch-1' });
      return { id, frame };
    };
    return { ...ws, ...connection, caller, input, invoke, read, start, attach };
  }

  const accept = (frame: FleetActionInvokeMessage, generation = 'worker-1'): FleetActionAcceptMessage => ({
    v: 1, id: 'accept', type: 'action.accept', invocation_id: frame.invocation_id,
    execution_id: frame.task_execution!.execution_id, worker_generation: generation,
  });
  const result = (frame: FleetActionInvokeMessage, overrides: Record<string, unknown> = {}): FleetActionResultMessage => ({
    ...accept(frame), id: 'result', type: 'action.result', final: true, output: { answer: 42 }, ...overrides,
  } as FleetActionResultMessage);

  it('requires idempotency and valid correlation context, including node-addressed entry points', async () => {
    const t = await setup();
    for (const response of [await t.invoke(null), await t.invoke('bad', {}), await t.invoke('node', t.input, '/v1/nodes/alpha/actions/task.run/invoke')]) {
      expect(response.status).toBe(400);
    }
    expect(t.sock.ofType('action.invoke')).toHaveLength(0);
  });

  it('registration and acceptance remain nonterminal; only an explicit final result completes with output and accounting', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    expect(await t.read(id)).toMatchObject({ status: 'dispatched', output: null });
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    expect(t.sock.ofType('reply').at(-1)).toMatchObject({ id: 'accept', ok: true, data: { newly_accepted: true, status: 'running' } });
    await t.handle.handleMessage(JSON.stringify(result(frame, { final: false, output: { ready: true } })));
    expect(await t.read(id)).toMatchObject({ status: 'running', output: null });
    await t.handle.handleMessage(JSON.stringify(result(frame, { accounting: { tokens: 37 } })));
    expect(t.sock.ofType('reply').at(-1)).toMatchObject({ id: 'result', ok: true, data: { status: 'completed', output: { answer: 42 }, task_execution: { accounting: { tokens: 37 } } } });
    expect(await t.read(id)).toMatchObject({ status: 'completed', output: { answer: 42 }, task_execution: { worker_generation: 'worker-1', accounting: { tokens: 37 } } });
  });

  it('concurrent invoke retries dispatch once and reject changed input', async () => {
    const t = await setup();
    const responses = await Promise.all([t.invoke(), t.invoke(), t.invoke()]);
    const ids = await Promise.all(responses.map(async r => { expect([200, 201]).toContain(r.status); return (await r.json()).data.invocation_id; }));
    expect(new Set(ids).size).toBe(1);
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
    expect((await t.invoke('key-1', { ...t.input, task: 'different' })).status).toBe(409);
  });

  it('rejects completion without acceptance or fences, and cannot switch the accepted generation', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'task_not_accepted' });
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    await t.handle.handleMessage(JSON.stringify(result(frame, { final: undefined })));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'invalid_message' });
    await t.handle.handleMessage(JSON.stringify(accept(frame, 'worker-2')));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'stale_task_execution' });
    await t.handle.handleMessage(JSON.stringify(result(frame, { worker_generation: 'worker-2' })));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'stale_task_execution' });
    expect(await t.read(id)).toMatchObject({ status: 'running', output: null });
  });

  it('reconciles duplicate terminal results and rejects a conflicting terminal payload', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    await t.handle.handleMessage(JSON.stringify(result(frame, { output: { a: 1, b: 2 } })));
    const first = await t.read(id);
    await t.handle.handleMessage(JSON.stringify(result(frame, { output: { b: 2, a: 1 } })));
    expect(t.sock.ofType('reply').at(-1)).toMatchObject({ ok: true, data: { status: 'completed' } });
    expect(await t.read(id)).toEqual(first);
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'task_result_conflict' });
    expect(await t.read(id)).toEqual(first);
  });

  it('fences stale completions after redispatch before acceptance', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    const [row] = await stack.runtime.handle.db.select().from(actionInvocations).where(eq(actionInvocations.id, id));
    await rescheduleNodeInvocation(stack.runtime.handle.db, stack.runtime.realtime, row);
    const [pending] = await stack.runtime.handle.db.select().from(actionInvocations).where(eq(actionInvocations.id, id));
    expect(pending.status).toBe('pending');
    await rescheduleNodeInvocation(stack.runtime.handle.db, stack.runtime.realtime, pending, { allowAttemptedFallback: true });
    const next = t.sock.ofType('action.invoke').at(-1) as FleetActionInvokeMessage;
    expect(next.task_execution!.execution_id).not.toBe(frame.task_execution!.execution_id);
    expect(next.task_execution!.deadline).toBe(frame.task_execution!.deadline);
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'stale_task_execution' });
    await t.handle.handleMessage(JSON.stringify(accept(next, 'worker-2')));
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('error').at(-1)).toMatchObject({ code: 'stale_task_execution' });
    await t.handle.handleMessage(JSON.stringify(result(next, { worker_generation: 'worker-2' })));
    expect(await t.read(id)).toMatchObject({ status: 'completed' });
  });

  it('does not redispatch accepted tasks after the short timeout or reconnect; replay reconciles ownership', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime);
    await rescheduleInvocationsForLostNode(stack.runtime.handle.db, stack.runtime.realtime, t.workspaceId, 'node_a');
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
    await t.handle.handleClose();
    const reconnected = await t.attach();
    await reconnected.handle.handleMessage(JSON.stringify(accept(frame)));
    expect(reconnected.sock.ofType('reply').at(-1)).toMatchObject({ ok: true, data: { status: 'running', newly_accepted: false } });
    expect(reconnected.sock.ofType('action.invoke')).toHaveLength(0);
    await reconnected.handle.handleMessage(JSON.stringify(result(frame)));
    expect(await t.read(id)).toMatchObject({ status: 'completed' });
  });

  it('never acknowledges a result before its database commit and retries after a storage failure', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    stack.runtime.handle.sqlite.exec("CREATE TRIGGER reject_task_result BEFORE UPDATE OF status ON action_invocations WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('reply').filter(r => r.id === 'result')).toHaveLength(0);
    expect(await t.read(id)).toMatchObject({ status: 'running', output: null });
    stack.runtime.handle.sqlite.exec('DROP TRIGGER reject_task_result');
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('reply').at(-1)).toMatchObject({ id: 'result', ok: true });
    expect(await t.read(id)).toMatchObject({ status: 'completed' });
  });

  it('reconciles a committed final result whose acknowledgment was lost', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    const send = t.sock.send.bind(t.sock);
    const dropped = vi.spyOn(t.sock, 'send').mockImplementation(data => {
      const value = JSON.parse(String(data));
      if (value.type === 'reply' && value.id === 'result') return;
      send(data);
    });
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('reply').filter(r => r.id === 'result')).toHaveLength(0);
    expect(await t.read(id)).toMatchObject({ status: 'completed' });
    dropped.mockRestore();
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(t.sock.ofType('reply').at(-1)).toMatchObject({ id: 'result', ok: true, data: { status: 'completed' } });
  });

  it.each([false, true])('bounds missing final results by a durable deadline (accepted=%s)', async accepted => {
    const t = await setup(1000);
    const { id, frame } = await t.start();
    if (accepted) await t.handle.handleMessage(JSON.stringify(accept(frame)));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2000);
    expect(await t.read(id)).toMatchObject({ status: 'failed', error: 'task_deadline_exceeded', output: null });
    await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime);
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(await t.read(id)).toMatchObject({ status: 'failed', error: 'task_deadline_exceeded' });
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
  });

  it('persists accepted ownership and terminal failure across two database reopens', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    await stack.settle();
    const directory = await mkdtemp(join(tmpdir(), 'relaycast-task-'));
    const path = join(directory, 'restart.sqlite');
    try {
      await stack.runtime.handle.sqlite.backup(path);
      const first = getSqliteDb(path);
      const failure = result(frame, { output: undefined, error: 'worker_exited_without_final' });
      try {
        expect(await acceptTaskInvocation(first.db, t.workspaceId, 'node_a', 'default', accept(frame))).toMatchObject({ status: 'running', newly_accepted: false });
        expect(await completeTaskInvocation(first.db, t.workspaceId, 'node_a', 'default', failure)).toMatchObject({ receipt: { status: 'failed', error: 'worker_exited_without_final' } });
      } finally { first.sqlite.close(); }
      const second = getSqliteDb(path);
      try {
        expect(await getInvocation(second.db, t.workspaceId, 'task.run', id)).toMatchObject({ status: 'failed', error: 'worker_exited_without_final' });
        expect(await completeTaskInvocation(second.db, t.workspaceId, 'node_a', 'default', failure)).toMatchObject({ receipt: { status: 'failed' }, completed: undefined });
        await expect(completeTaskInvocation(second.db, 'different-workspace', 'node_a', 'default', failure)).rejects.toThrow();
        await expect(completeTaskInvocation(second.db, t.workspaceId, 'different-node', 'default', failure)).rejects.toThrow();
      } finally { second.sqlite.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('recovers a crash after the durable claim but before sending without creating another logical invocation', async () => {
    const t = await setup();
    const send = vi.spyOn(stack.runtime.realtime, 'sendAuthorizedActionToProvider').mockRejectedValueOnce(new Error('simulated process loss before send'));
    const response = await t.invoke();
    expect(response.status).toBe(500);
    const [claimed] = await stack.runtime.handle.db.select().from(actionInvocations);
    expect(claimed.taskState).toMatchObject({ run_id: 'run-1' });
    expect(t.sock.ofType('action.invoke')).toHaveLength(0);
    send.mockRestore();
    const replay = await t.invoke();
    expect((await replay.json()).data.invocation_id).toBe(claimed.id);
    expect(t.sock.ofType('action.invoke')).toHaveLength(0);
    await rescheduleNodeInvocation(stack.runtime.handle.db, stack.runtime.realtime, claimed);
    const [pending] = await stack.runtime.handle.db.select().from(actionInvocations).where(eq(actionInvocations.id, claimed.id));
    await rescheduleNodeInvocation(stack.runtime.handle.db, stack.runtime.realtime, pending, { allowAttemptedFallback: true });
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
    const frame = t.sock.ofType('action.invoke')[0] as FleetActionInvokeMessage;
    expect(frame.task_execution).toMatchObject({ execution_id: `${claimed.id}/2`, deadline: claimed.taskState!.deadline });
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    await t.handle.handleMessage(JSON.stringify(result(frame)));
    expect(await t.read(claimed.id)).toMatchObject({ status: 'completed' });
  });

  it('does not acknowledge failed acceptance and a stale retry snapshot cannot move an accepted execution', async () => {
    const t = await setup();
    const { id, frame } = await t.start();
    const [stale] = await stack.runtime.handle.db.select().from(actionInvocations).where(eq(actionInvocations.id, id));
    stack.runtime.handle.sqlite.exec("CREATE TRIGGER reject_task_accept BEFORE UPDATE OF status ON action_invocations WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    expect(t.sock.ofType('reply').filter(r => r.id === 'accept')).toHaveLength(0);
    expect(await t.read(id)).toMatchObject({ status: 'dispatched' });
    stack.runtime.handle.sqlite.exec('DROP TRIGGER reject_task_accept');
    await t.handle.handleMessage(JSON.stringify(accept(frame)));
    await rescheduleNodeInvocation(stack.runtime.handle.db, stack.runtime.realtime, stale, { allowAttemptedFallback: true });
    expect(t.sock.ofType('action.invoke')).toHaveLength(1);
    expect(await t.read(id)).toMatchObject({ status: 'running', task_execution: { execution_id: frame.task_execution!.execution_id } });
  });

  it('preserves legacy short action completion without the task handshake', async () => {
    const t = await setup();
    const response = await t.invoke(null, { value: 'echo' }, '/v1/actions/echo/invoke');
    expect(response.status).toBe(201);
    const id = (await response.json()).data.invocation_id;
    const frame = t.sock.ofType('action.invoke').at(-1) as FleetActionInvokeMessage;
    expect(frame.task_execution).toBeUndefined();
    await t.handle.handleMessage(JSON.stringify({ v: 1, type: 'action.result', invocation_id: id, output: { echoed: true } }));
    expect(await getInvocation(stack.runtime.handle.db, t.workspaceId, 'echo', id)).toMatchObject({ status: 'completed', output: { echoed: true } });
  });
});
