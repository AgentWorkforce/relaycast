import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { serializeNodeOp } from '../../engine/nodeLock.js';
import * as delivery from '../../engine/delivery.js';

vi.mock('../../engine/delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine/delivery.js')>();
  return { ...actual, ackDeliveriesUpToSeq: vi.fn(actual.ackDeliveriesUpToSeq) };
});

/**
 * A node acks cumulatively (`up_to_seq`) every few ms. While its control queue
 * is busy, newer acks for the same agent fold into the one already queued
 * instead of queueing a closure each, so a slow database cannot grow the
 * queue (and the heap) without bound. Acks for other agents stay separate,
 * and the folded ack settles everything up to the highest seq it saw.
 */
describe('node delivery.ack coalescing', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  const authed = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

  it('folds queued acks for one agent into a single ack at the highest seq', async () => {
    const ws = await createWorkspace(stack.app, 'ack-coalesce');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const create = await stack.app.request('/v1/nodes', authed(ws.workspaceKey, {
      method: 'POST',
      body: JSON.stringify({ node_id: 'node_ack', name: 'node_ack', capabilities: ['spawn:claude'], max_agents: 4, tags: [], version: 'v0' }),
    }));
    expect(create.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_ack', sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name: 'node_ack', node_id: 'node_ack',
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }], max_agents: 4, tags: [], version: 'v0', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true }));
    for (const name of ['bob', 'carol']) {
      await handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.register', name, resumable: true }));
    }
    for (let i = 0; i < 3; i += 1) {
      const post = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
        method: 'POST', body: JSON.stringify({ text: `m${i}` }),
      }));
      expect(post.status).toBe(201);
    }
    await stack.settle();
    expect(sock.ofType('deliver')).toHaveLength(6);

    // Hold the node's control queue, then burst acks as a busy node would.
    let release!: () => void;
    let started!: () => void;
    const holding = new Promise<void>((resolve) => { started = resolve; });
    const held = serializeNodeOp(ws.workspaceId, 'node_ack', () => new Promise<void>((resolve) => { release = resolve; started(); }));
    await holding;
    const ackSpy = vi.mocked(delivery.ackDeliveriesUpToSeq);
    ackSpy.mockClear();
    const frames: Promise<void>[] = [];
    for (const seq of [1, 3, 2, 3, 1]) {
      frames.push(handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: seq })));
    }
    frames.push(handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'carol', up_to_seq: 2 })));
    release();
    await held;
    await Promise.all(frames);
    await stack.settle();

    expect(ackSpy.mock.calls.map((call) => [call[4], call[5]])).toEqual([['bob', 3], ['carol', 2]]);
    const sqlite = stack.runtime.handle.sqlite;
    const statuses = sqlite.prepare(`
      SELECT a.name, d.seq, d.status FROM deliveries d JOIN agents a ON a.id = d.agent_id
      WHERE d.workspace_id = ? ORDER BY a.name, d.seq
    `).all(ws.workspaceId) as Array<{ name: string; seq: number; status: string }>;
    expect(statuses).toEqual([
      { name: 'bob', seq: 1, status: 'acked' },
      { name: 'bob', seq: 2, status: 'acked' },
      { name: 'bob', seq: 3, status: 'acked' },
      { name: 'carol', seq: 1, status: 'acked' },
      { name: 'carol', seq: 2, status: 'acked' },
      { name: 'carol', seq: 3, status: 'delivered' },
    ]);

    // Once the queue is idle, the next ack runs on its own again.
    ackSpy.mockClear();
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'carol', up_to_seq: 3 }));
    expect(ackSpy).toHaveBeenCalledTimes(1);
  });
});
