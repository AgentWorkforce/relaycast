import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('DM unread cursor', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  const authed = (token: string) => ({
    post: (path: string, body?: unknown) =>
      stack.app.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    get: (path: string) => stack.app.request(path, { headers: { authorization: `Bearer ${token}` } }),
  });

  async function unreadCount(token: string, conversationId: string): Promise<number> {
    const res = await authed(token).get('/v1/inbox');
    expect(res.status).toBe(200);
    const inbox = (await res.json()).data as {
      unread_dms: Array<{ conversation_id: string; unread_count: number }>;
    };
    return inbox.unread_dms.find((row) => row.conversation_id === conversationId)?.unread_count ?? 0;
  }

  it('drops a 1:1 DM unread count as markRead advances the participant cursor', async () => {
    const ws = await createWorkspace(stack.app, 'dm-unread');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const firstRes = await authed(alice.token).post('/v1/dm', { to: 'bob', text: 'one' });
    expect(firstRes.status).toBeLessThan(300);
    const first = (await firstRes.json()).data as { id: string; conversation_id: string };
    const secondRes = await authed(alice.token).post('/v1/dm', { to: 'bob', text: 'two' });
    expect(secondRes.status).toBeLessThan(300);
    const second = (await secondRes.json()).data as { id: string };

    expect(await unreadCount(bob.token, first.conversation_id)).toBe(2);

    const readFirst = await authed(bob.token).post(`/v1/messages/${first.id}/read`);
    expect(readFirst.status).toBe(200);
    expect(await unreadCount(bob.token, first.conversation_id)).toBe(1);

    const readSecond = await authed(bob.token).post(`/v1/messages/${second.id}/read`);
    expect(readSecond.status).toBe(200);
    expect(await unreadCount(bob.token, first.conversation_id)).toBe(0);

    // An older id does not pull the cursor backward.
    const readOlder = await authed(bob.token).post(`/v1/messages/${first.id}/read`);
    expect(readOlder.status).toBe(200);
    expect(await unreadCount(bob.token, first.conversation_id)).toBe(0);

    const thirdRes = await authed(alice.token).post('/v1/dm', { to: 'bob', text: 'three' });
    expect(thirdRes.status).toBeLessThan(300);
    expect(await unreadCount(bob.token, first.conversation_id)).toBe(1);

    // Alice's own sends are not unread for Alice.
    expect(await unreadCount(alice.token, first.conversation_id)).toBe(0);
  });

  it('drops a group DM unread count from the same participant cursor', async () => {
    const ws = await createWorkspace(stack.app, 'group-dm-unread');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const create = await authed(alice.token).post('/v1/dm/group', { participants: ['bob'] });
    expect(create.status).toBe(201);
    const conversationId = ((await create.json()) as { data: { id: string } }).data.id;

    const msg = await authed(alice.token).post(`/v1/dm/${conversationId}/messages`, { text: 'hello group' });
    expect(msg.status).toBe(201);
    const messageId = ((await msg.json()) as { data: { id: string } }).data.id;

    expect(await unreadCount(bob.token, conversationId)).toBe(1);
    const read = await authed(bob.token).post(`/v1/messages/${messageId}/read`);
    expect(read.status).toBe(200);
    expect(await unreadCount(bob.token, conversationId)).toBe(0);
  });

  it('drops DM unread when the recipient acks the delivery', async () => {
    const ws = await createWorkspace(stack.app, 'dm-unread-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const sentRes = await authed(alice.token).post('/v1/dm', { to: 'bob', text: 'ack me' });
    expect(sentRes.status).toBeLessThan(300);
    const sent = (await sentRes.json()).data as { conversation_id: string };
    expect(await unreadCount(bob.token, sent.conversation_id)).toBe(1);

    const queued = await authed(bob.token).get('/v1/deliveries');
    expect(queued.status).toBe(200);
    const deliveryId = ((await queued.json()).data as Array<{ id: string }>)[0]?.id;
    expect(deliveryId).toBeTruthy();

    const ack = await authed(bob.token).post(`/v1/deliveries/${deliveryId}/ack`);
    expect(ack.status).toBe(200);
    expect(await unreadCount(bob.token, sent.conversation_id)).toBe(0);
  });

  it('still clears channel unread from the channel membership cursor', async () => {
    const ws = await createWorkspace(stack.app, 'channel-unread');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const post = await authed(alice.token).post('/v1/channels/general/messages', { text: 'hello channel' });
    expect(post.status).toBeLessThan(300);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;

    const before = await authed(bob.token).get('/v1/inbox');
    const beforeInbox = (await before.json()).data as {
      unread_channels: Array<{ channel_name: string; unread_count: number }>;
    };
    expect(beforeInbox.unread_channels.find((row) => row.channel_name === 'general')?.unread_count).toBe(1);

    const read = await authed(bob.token).post(`/v1/messages/${messageId}/read`);
    expect(read.status).toBe(200);

    const after = await authed(bob.token).get('/v1/inbox');
    const afterInbox = (await after.json()).data as {
      unread_channels: Array<{ channel_name: string; unread_count: number }>;
    };
    expect(afterInbox.unread_channels.find((row) => row.channel_name === 'general')).toBeUndefined();
  });
});
