import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { triggerIntegrationMessage } from '../../engine/inboundWebhook.js';
import { messages } from '../../db/schema.js';

describe('integration delivery backpressure and join freshness', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });
  it('rejects a full mailbox atomically, keeps unique events retryable, and never replays pre-join events', async () => {
    const ws = await createWorkspace(stack.app, 'backpressure');
    const busy = await registerAgent(stack.app, ws.workspaceKey, 'busy');
    const post = (path: string, token: string, body?: unknown) => stack.app.request(path, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const response = await post('/v1/channels', busy.token, { name: 'events' });
    const { data: channel } = await response.json();
    const db = stack.runtime.handle.db;
    const emit = (text: string) => triggerIntegrationMessage(db, ws.workspaceId, channel.id,
      { text, source: 'github', author: 'GitHub' }, { mailbox: { ttlMs: 60_000, depthCap: 1 } });
    const first = await emit('unique-first');
    const late = await registerAgent(stack.app, ws.workspaceKey, 'late');
    await post('/v1/channels/events/join', late.token);
    await expect(emit('unique-second')).rejects.toMatchObject({ code: 'mailbox_full', status: 503 });
    expect(await db.select().from(messages).where(eq(messages.channelId, channel.id))).toHaveLength(1);
    const list = async (token: string) => (await (await stack.app.request('/v1/deliveries', { headers: { authorization: `Bearer ${token}` } })).json()).data;
    expect(await list(late.token)).toHaveLength(0);
    const queued = await list(busy.token);
    expect(queued.map((d: { message_id: string }) => d.message_id)).toEqual([first.message_id]);
    expect((await post(`/v1/deliveries/${queued[0].id}/ack`, busy.token)).status).toBe(200);
    const retried = await emit('unique-second');
    expect((await list(late.token)).map((d: { message_id: string }) => d.message_id)).toEqual([retried.message_id]);
    expect((await list(busy.token)).map((d: { message_id: string }) => d.message_id)).toEqual([retried.message_id]);
  });
  it('bounds concurrent unique events and preserves every rejected event for retry', async () => {
    const ws = await createWorkspace(stack.app, 'concurrent-backpressure');
    const busy = await registerAgent(stack.app, ws.workspaceKey, 'busy-burst');
    const headers = { authorization: `Bearer ${busy.token}`, 'content-type': 'application/json' };
    const ch = await stack.app.request('/v1/channels', { method: 'POST', headers, body: JSON.stringify({ name: 'burst' }) });
    const { data: channel } = await ch.json();
    const db = stack.runtime.handle.db;
    const emit = (text: string) => triggerIntegrationMessage(db, ws.workspaceId, channel.id,
      { text, source: 'github', author: 'GitHub' }, { mailbox: { ttlMs: 60_000, depthCap: 2 } });
    const events = Array.from({length: 8}, (_, i) => `unique-${i}`);
    const burst = await Promise.allSettled(events.map(emit));
    expect(burst.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = burst.flatMap((r, i) => {
      if (r.status === 'fulfilled') return [];
      expect(r.reason).toMatchObject({ code: 'mailbox_full', status: 503 });
      return [events[i]];
    });
    for (const text of rejected) {
      const inbox = await stack.app.request('/v1/deliveries', { headers });
      for (const delivery of (await inbox.json()).data) {
        expect((await stack.app.request(`/v1/deliveries/${delivery.id}/ack`, { method: 'POST', headers })).status).toBe(200);
      }
      await emit(text);
    }
    const stored = await db.select().from(messages).where(eq(messages.channelId, channel.id));
    expect(stored.map(m => m.body).sort()).toEqual(events.sort());
  });

});
