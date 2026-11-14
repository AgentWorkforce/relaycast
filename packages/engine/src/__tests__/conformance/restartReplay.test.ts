import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { createWorkspace, makeNodeStack, pgMode, registerAgent } from './harness.js';

/**
 * Restart and replay over durable storage, in both conformance modes: stack A
 * writes a workspace, agents, a channel, channel messages and DMs (so
 * deliveries and read cursors exist) and acks some deliveries; it closes and
 * stack B opens the same durable data (SQLite: the same database file;
 * PostgreSQL: the same schema over the shared pool). Everything is asserted
 * through the HTTP API: state survives, replaying the delivery queue after the
 * restart yields each unacked delivery exactly once, acked ones stay acked,
 * and new traffic continues each recipient's sequence.
 */
describe('restart and replay over durable storage', () => {
  let dir: string | undefined;
  let dbPath: string | undefined;

  beforeEach(() => {
    if (!pgMode) {
      dir = mkdtempSync(join(tmpdir(), 'relaycast-restart-replay-'));
      dbPath = join(dir, 'relaycast.db');
    }
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    dbPath = undefined;
  });

  type Json = Record<string, unknown>;

  async function call(app: Hono<AppEnv>, token: string, path: string, body?: unknown): Promise<Json> {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(res.status, `${path}: ${res.status}`).toBeLessThan(300);
    return (await res.json()) as Json;
  }

  const dataOf = <T>(body: Json) => body.data as T;
  type Delivery = { id: string; message_id: string; status: string; seq: number };
  const deliveries = async (app: Hono<AppEnv>, token: string, query = '') =>
    dataOf<Delivery[]>(await call(app, token, `/v1/deliveries${query}`));
  const byId = (rows: Delivery[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

  /** The durable, restart-relevant view of the workspace through the API. */
  async function snapshot(app: Hono<AppEnv>, keys: { workspaceKey: string; bob: string; carol: string }) {
    const workspace = dataOf<Json>(await call(app, keys.workspaceKey, '/v1/workspace'));
    const agents = dataOf<Array<{ name: string }>>(await call(app, keys.workspaceKey, '/v1/agents'));
    const history = dataOf<Array<{ id: string; text: string }>>(
      await call(app, keys.bob, '/v1/channels/restart-chat/messages'),
    );
    const bobInbox = dataOf<Json>(await call(app, keys.bob, '/v1/inbox'));
    const carolInbox = dataOf<Json>(await call(app, keys.carol, '/v1/inbox'));
    const conversations = dataOf<Json[]>(await call(app, keys.bob, '/v1/dm/conversations'));
    return {
      workspace: { id: workspace.id, name: workspace.name },
      agents: agents.map((agent) => agent.name).sort(),
      history: history.map((message) => ({ id: message.id, text: message.text })),
      bobInbox: { unread_channels: bobInbox.unread_channels, unread_dms: bobInbox.unread_dms },
      carolInbox: { unread_channels: carolInbox.unread_channels, unread_dms: carolInbox.unread_dms },
      conversations: conversations.length,
      bobPending: byId(await deliveries(app, keys.bob)),
      bobAcked: byId(await deliveries(app, keys.bob, '?status=acked')),
      carolPending: byId(await deliveries(app, keys.carol)),
    };
  }

  it('keeps workspace, agents, history, cursors and the delivery queue, and replays exactly once', async () => {
    const a = makeNodeStack({ dbPath });
    const ws = await createWorkspace(a.app, 'restart-replay');
    const alice = await registerAgent(a.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(a.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(a.app, ws.workspaceKey, 'carol');
    await call(a.app, ws.workspaceKey, '/v1/channels', { name: 'restart-chat' });
    for (const agent of [alice, bob, carol]) {
      await call(a.app, agent.token, '/v1/channels/restart-chat/join', {});
    }
    const posted: string[] = [];
    for (const text of ['one', 'two', 'three']) {
      posted.push(dataOf<{ id: string }>(
        await call(a.app, alice.token, '/v1/channels/restart-chat/messages', { text }),
      ).id);
    }
    const dms: string[] = [];
    for (const text of ['dm one', 'dm two']) {
      dms.push(dataOf<{ id: string }>(await call(a.app, alice.token, '/v1/dm', { to: 'bob', text })).id);
    }
    await a.settle();

    // Bob has a delivery per channel message and DM, carol one per channel message.
    const bobBefore = await deliveries(a.app, bob.token);
    expect(bobBefore.map((d) => d.message_id).sort()).toEqual([...posted, ...dms].sort());
    expect(new Set(bobBefore.map((d) => d.seq)).size).toBe(5);
    expect((await deliveries(a.app, carol.token)).map((d) => d.message_id).sort()).toEqual([...posted].sort());

    // Bob acks the first channel message and the first DM.
    const ackTargets = bobBefore.filter((d) => d.message_id === posted[0] || d.message_id === dms[0]);
    expect(ackTargets).toHaveLength(2);
    for (const delivery of ackTargets) {
      expect(dataOf<Delivery>(await call(a.app, bob.token, `/v1/deliveries/${delivery.id}/ack`, {})).status).toBe('acked');
    }
    await a.settle();

    const keys = { workspaceKey: ws.workspaceKey, bob: bob.token, carol: carol.token };
    const before = await snapshot(a.app, keys);
    expect(before.workspace.id).toBe(ws.workspaceId);
    expect(before.agents).toEqual(['alice', 'bob', 'carol']);
    expect(before.history.map((message) => message.id).sort()).toEqual([...posted].sort());
    expect(ids(before.bobAcked)).toEqual(ids(ackTargets));
    expect(before.bobPending.map((d) => d.message_id).sort()).toEqual([posted[1], posted[2], dms[1]].sort());
    // Acks advanced bob's read cursors: two unread channel messages, one unread DM.
    expect(before.bobInbox.unread_channels).toEqual([{ channel_name: 'restart-chat', unread_count: 2 }]);
    expect(before.bobInbox.unread_dms).toEqual([expect.objectContaining({ from: 'alice', unread_count: 1 })]);
    expect(before.carolInbox.unread_channels).toEqual([{ channel_name: 'restart-chat', unread_count: 3 }]);
    expect(before.conversations).toBe(1);

    await a.close();

    // Restart: a new stack over the same durable data, same credentials.
    const b = makeNodeStack({ dbPath });
    expect(await snapshot(b.app, keys)).toEqual(before);

    // Replay: bob drains his queue twice; every unacked delivery comes back
    // exactly once, and only acks change what a later replay returns.
    const replay = await deliveries(b.app, bob.token);
    expect(ids(replay)).toEqual(ids(before.bobPending));
    expect(ids(await deliveries(b.app, bob.token))).toEqual(ids(replay));
    for (const delivery of replay) {
      expect(dataOf<Delivery>(await call(b.app, bob.token, `/v1/deliveries/${delivery.id}/ack`, {})).status).toBe('acked');
    }
    // A re-ack of a delivery acked before the restart is an idempotent no-op.
    const reacked = dataOf<Delivery>(await call(b.app, bob.token, `/v1/deliveries/${ackTargets[0]!.id}/ack`, {}));
    expect(reacked).toMatchObject({ id: ackTargets[0]!.id, status: 'acked' });
    await b.settle();
    expect(await deliveries(b.app, bob.token)).toEqual([]);
    const acked = await deliveries(b.app, bob.token, '?status=acked');
    expect(ids(acked)).toEqual(ids(bobBefore));
    expect(new Set(acked.map((d) => d.message_id)).size).toBe(5);
    const bobInbox = dataOf<Json>(await call(b.app, bob.token, '/v1/inbox'));
    expect(bobInbox.unread_channels).toEqual([]);
    expect(bobInbox.unread_dms).toEqual([]);
    // Carol's queue is untouched by bob's replay.
    expect(byId(await deliveries(b.app, carol.token))).toEqual(before.carolPending);

    // New traffic after the restart: one new delivery each, continuing the sequence.
    const after = dataOf<{ id: string }>(
      await call(b.app, alice.token, '/v1/channels/restart-chat/messages', { text: 'four' }),
    ).id;
    await b.settle();
    const fresh = await deliveries(b.app, bob.token);
    expect(fresh.map((d) => d.message_id)).toEqual([after]);
    expect(fresh[0]!.seq).toBeGreaterThan(Math.max(...bobBefore.map((d) => d.seq)));
    expect(fresh[0]!.id).not.toBeOneOf(ids(bobBefore));
    const carolFresh = await deliveries(b.app, carol.token);
    expect(carolFresh.map((d) => d.message_id).sort()).toEqual([...posted, after].sort());
    expect(
      dataOf<Array<{ id: string }>>(await call(b.app, bob.token, '/v1/channels/restart-chat/messages'))
        .map((message) => message.id).sort(),
    ).toEqual([...posted, after].sort());
  });
});
