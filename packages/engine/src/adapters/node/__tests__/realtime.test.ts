import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, nodes, workspaceEvents } from '../../../db/tables.js';
import {
  FakeSocket,
  attachDirectNodeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from '../../../__tests__/conformance/harness.js';

/** The SDK's direct-node `node.register` (no provider identity), optionally with an explicit one. */
function directRegisterFrame(agent: { agentId: string }, id: string, provider?: { name: string; instance_id: string }): string {
  return JSON.stringify({
    v: 1,
    id,
    type: 'node.register',
    node_id: `node_direct_${agent.agentId}`,
    name: `direct-${agent.agentId}`,
    capabilities: [],
    max_agents: 1,
    tags: ['implicit', 'direct', 'test'],
    version: 'test-direct-node',
    resume_cursor: null,
    ...(provider ? { provider } : {}),
  });
}

describe('InProcessRealtime direct node reconnect', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  async function setup() {
    const ws = await createWorkspace(stack.app, 'reconnect');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const json = (method: string, path: string, token: string, body?: unknown) => stack.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const nodeId = `node_direct_${alice.agentId}`;
    const db = stack.runtime.deps.db;
    const aliceStatus = async () => {
      const res = await json('GET', '/v1/agents', ws.workspaceKey);
      const { data } = await res.json() as { data: { name: string; status: string }[] };
      return data.find((agent) => agent.name === 'alice')?.status;
    };
    const nodeStatus = async () => (await db.select({ status: nodes.status }).from(nodes).where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, nodeId))))[0]?.status;
    const statusEvents = async () => (await db.select({ type: workspaceEvents.type, seq: workspaceEvents.seq }).from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, ws.workspaceId)).orderBy(workspaceEvents.seq))
      .map((event) => event.type).filter((type) => type.startsWith('node.status.'));
    const invoke = async (handler: FakeSocket, others: FakeSocket[]) => {
      const invoked = await json('POST', '/v1/actions/crm.lookup/invoke', bob.token, { input: { name: 'ada' } });
      const body = await invoked.json() as { data: { status: string; invocation_id: string } };
      expect(invoked.status, JSON.stringify(body)).toBe(201);
      expect(body.data.status).toBe('dispatched');
      expect(handler.ofType('action.invoke')).toEqual([expect.objectContaining({ action: 'crm.lookup', invocation_id: body.data.invocation_id })]);
      for (const other of others) expect(other.ofType('action.invoke')).toEqual([]);
    };
    expect((await json('POST', '/v1/actions', ws.workspaceKey, { name: 'crm.lookup', description: 'Look someone up', handler_agent: 'alice' })).status).toBe(201);
    const attach = () => {
      const sock = new FakeSocket();
      const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
      return { sock, handle };
    };
    const expectOnline = async () => {
      expect(stack.runtime.realtime.isNodeConnected(ws.workspaceId, nodeId)).toBe(true);
      expect(stack.runtime.realtime.isProviderConnected(ws.workspaceId, nodeId, 'default')).toBe(true);
      expect(stack.runtime.realtime.isProviderAttached(ws.workspaceId, nodeId, 'default')).toBe(true);
      expect(await nodeStatus()).toBe('online');
      expect(await aliceStatus()).toBe('active');
      expect(await statusEvents()).toEqual(['node.status.online']);
    };
    const expectOfflineOnce = async () => {
      expect(stack.runtime.realtime.isNodeConnected(ws.workspaceId, nodeId)).toBe(false);
      expect(await nodeStatus()).toBe('offline');
      expect(await aliceStatus()).toBe('offline');
      expect(await statusEvents()).toEqual(['node.status.online', 'node.status.offline']);
    };
    return { ws, alice, bob, json, nodeId, aliceStatus, nodeStatus, statusEvents, invoke, attach, expectOnline, expectOfflineOnce };
  }

  it('brings the bound agent back with its node when the client re-registers after a disconnect', async () => {
    const { ws, alice, aliceStatus, invoke } = await setup();

    const first = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    expect(await aliceStatus()).toBe('active');
    // The socket drops: the teardown takes the node and its agent offline.
    await first.handle.handleClose();
    expect(await aliceStatus()).toBe('offline');

    // The client reconnects and re-registers; no heartbeat has been sent yet.
    const second = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    expect(await aliceStatus()).toBe('active');
    await invoke(second.sock, [first.sock]);
  });

  it('ignores the late close of a socket a reconnect already superseded', async () => {
    const { alice, attach, invoke, expectOnline, expectOfflineOnce } = await setup();

    // The SDK reconnects by closing the old socket and opening a new one; the
    // server learns of the old close only after the new socket registered.
    const first = attach();
    await first.handle.handleMessage(directRegisterFrame(alice, 'r1'));
    expect(first.sock.ofType('reply')).toEqual([expect.objectContaining({ id: 'r1', ok: true })]);
    const second = attach();
    await second.handle.handleMessage(directRegisterFrame(alice, 'r2'));
    expect(second.sock.received).toEqual([expect.objectContaining({ id: 'r2', type: 'reply', ok: true })]);
    // The registry closed the superseded socket itself.
    expect(first.sock.closed).toBe(true);

    await first.handle.handleClose();
    await expectOnline();
    await invoke(second.sock, [first.sock]);

    // The live socket's close is the real one: a single offline transition.
    await second.handle.handleClose();
    await expectOfflineOnce();
  });

  it('ignores a close that reaches the node lock after the reconnect re-bound the provider', async () => {
    const { alice, attach, invoke, expectOnline, expectOfflineOnce } = await setup();

    const first = attach();
    await first.handle.handleMessage(directRegisterFrame(alice, 'r1'));
    const second = attach();
    // B's register is queued on the node lock when A's close starts: the close
    // unbinds A at once, so the register sees no incumbent and binds B; the
    // close's own teardown then runs after it and must find itself stale.
    const registering = second.handle.handleMessage(directRegisterFrame(alice, 'r2'));
    const closing = first.handle.handleClose();
    await Promise.all([registering, closing]);
    expect(second.sock.received).toEqual([expect.objectContaining({ id: 'r2', type: 'reply', ok: true })]);

    await expectOnline();
    await invoke(second.sock, [first.sock]);

    await second.handle.handleClose();
    await expectOfflineOnce();
  });

  it('refuses the frames a superseded socket still had queued, except those settling in-flight work', async () => {
    const { ws, alice, nodeId, attach, invoke, expectOnline } = await setup();

    const first = attach();
    await first.handle.handleMessage(directRegisterFrame(alice, 'r1'));
    const second = attach();
    await second.handle.handleMessage(directRegisterFrame(alice, 'r2'));
    expect(stack.runtime.realtime.isConnectionSuperseded(first.handle.connectionId)).toBe(true);
    expect(stack.runtime.realtime.isConnectionSuperseded(second.handle.connectionId)).toBe(false);

    // A deregister the old socket sent before it learned it was superseded
    // would otherwise remove the provider the new socket now holds.
    await first.handle.handleMessage(JSON.stringify({ v: 1, id: 'd1', type: 'node.deregister' }));
    expect(first.sock.ofType('error')).toEqual([expect.objectContaining({ id: 'd1', code: 'connection_superseded' })]);
    await first.handle.handleMessage(JSON.stringify({ v: 1, id: 'h1', type: 'node.heartbeat', active_agents: 1, handlers_live: false }));
    expect(first.sock.ofType('error')).toHaveLength(2);
    expect(stack.runtime.realtime.providerConnectionId(ws.workspaceId, nodeId, 'default')).toBe(second.handle.connectionId);
    await expectOnline();
    await invoke(second.sock, [first.sock]);

    // Settling work already dispatched to it still passes (an unknown id is the engine's usual answer, not a refusal).
    await first.handle.handleMessage(JSON.stringify({ v: 1, id: 'a1', type: 'action.accept', invocation_id: 'inv_missing' }));
    expect(first.sock.ofType('error').find((frame) => frame.id === 'a1')?.code).not.toBe('connection_superseded');

    await first.handle.handleClose();
    expect(stack.runtime.realtime.isConnectionSuperseded(first.handle.connectionId)).toBe(false);
    // A frame of the old socket that reaches the node lock only after its
    // close was processed is still refused: the state travels with the handle.
    await first.handle.handleMessage(JSON.stringify({ v: 1, id: 'd2', type: 'node.deregister' }));
    expect(first.sock.ofType('error').find((frame) => frame.id === 'd2')?.code).toBe('connection_superseded');
    expect(stack.runtime.realtime.providerConnectionId(ws.workspaceId, nodeId, 'default')).toBe(second.handle.connectionId);
    await expectOnline();
  });

  it("does not refresh the direct agent's liveness for a register the engine refused", async () => {
    const { ws, alice, aliceStatus, attach } = await setup();
    const db = stack.runtime.deps.db;
    const first = attach();
    await first.handle.handleMessage(directRegisterFrame(alice, 'r1'));
    expect(await aliceStatus()).toBe('active');

    // The agent lost liveness (as a sweep records it) while its socket stayed up.
    await db.update(agents).set({ status: 'offline', statusBeforeLivenessLoss: 'active' })
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.id, alice.agentId)));
    expect(await aliceStatus()).toBe('offline');

    // A malformed re-register is answered with an error and certifies nothing.
    await first.handle.handleMessage(JSON.stringify({ v: 1, id: 'bad', type: 'node.register' }));
    expect(first.sock.ofType('error')).toEqual([expect.objectContaining({ code: 'invalid_message' })]);
    expect(await aliceStatus()).toBe('offline');

    // An accepted one does.
    await first.handle.handleMessage(directRegisterFrame(alice, 'r2'));
    expect(first.sock.ofType('reply').map((frame) => frame.id)).toEqual(['r1', 'r2']);
    expect(await aliceStatus()).toBe('active');
  });

  it('still refuses an explicit different provider instance while the incumbent is live, and that close is real', async () => {
    const { ws, nodeId, alice, attach, aliceStatus } = await setup();

    const first = attach();
    await first.handle.handleMessage(directRegisterFrame(alice, 'r1', { name: 'default', instance_id: 'proc-a' }));
    const second = attach();
    await second.handle.handleMessage(directRegisterFrame(alice, 'r2', { name: 'default', instance_id: 'proc-b' }));
    expect(second.sock.received).toEqual([expect.objectContaining({ id: 'r2', type: 'error', code: 'provider_instance_conflict' })]);
    expect(first.sock.closed).toBe(false);
    expect(await aliceStatus()).toBe('active');

    // The duplicate never took the binding over, so the incumbent's close is a real provider loss.
    await first.handle.handleClose();
    expect(stack.runtime.realtime.isProviderAttached(ws.workspaceId, nodeId, 'default')).toBe(false);
    expect(await aliceStatus()).toBe('offline');
  });
});
