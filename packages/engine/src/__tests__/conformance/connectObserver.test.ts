import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { messages, observerTokens } from '../../db/schema.js';
import { dmMessagePageLimit } from '../../engine/dmAll.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

async function mintConnectObserver(
  stack: TestStack,
  workspaceKey: string,
  name: string,
  filters: { include_dms: true; agent_ids?: string[] } = { include_dms: true },
) {
  const response = await stack.app.request('/v1/observer-tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${workspaceKey}`,
    },
    body: JSON.stringify({
      name,
      scopes: ['stream:read', 'dms:read'],
      filters,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    data: { id: string; token: string };
  };
  return body.data;
}

async function sendDm(stack: TestStack, token: string, to: string, text: string) {
  const response = await stack.app.request('/v1/dm', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, text }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    data: { conversation_id: string };
  };
}

describe('Relay Connect observer capability', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });
  afterEach(() => stack.close());

  it('opens one room, reads historical and new DMs, and fails closed for writes, other rooms, expiry, revocation, and room deletion', async () => {
    expect(dmMessagePageLimit(101)).toBe(100);
    const roomA = await createWorkspace(stack.app, 'connect-room-a');
    const roomB = await createWorkspace(stack.app, 'connect-room-b');
    const alice = await registerAgent(stack.app, roomA.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, roomA.workspaceKey, 'bob');
    const mallory = await registerAgent(stack.app, roomB.workspaceKey, 'mallory');
    await registerAgent(stack.app, roomB.workspaceKey, 'victor');

    const historicalA = await sendDm(stack, alice.token, 'bob', 'historical room A');
    const privateB = await sendDm(stack, mallory.token, 'victor', 'private room B');
    const observer = await mintConnectObserver(stack, roomA.workspaceKey, 'connect-observer-a');

    const open = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${observer.token}` },
    });
    expect(open.status).toBe(200);
    await expect(open.json()).resolves.toMatchObject({
      data: { id: roomA.workspaceId, observer_token_id: observer.id },
    });

    await sendDm(stack, alice.token, 'bob', 'new room A');
    const conversations = await stack.app.request('/v1/dm/conversations/all?limit=100', {
      headers: { authorization: `Bearer ${observer.token}` },
    });
    expect(conversations.status).toBe(200);
    const conversationBody = (await conversations.json()) as {
      data: Array<{ id: string; participants: string[] }>;
    };
    expect(conversationBody.data).toHaveLength(1);
    expect(conversationBody.data[0]).toMatchObject({
      id: historicalA.data.conversation_id,
      participants: ['alice', 'bob'],
    });

    const history = await stack.app.request(
      `/v1/dm/conversations/${historicalA.data.conversation_id}/messages?limit=100&page=1`,
      { headers: { authorization: `Bearer ${observer.token}` } },
    );
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      data: {
        messages: Array<{ agent_name: string; created_at: string; text: string }>;
        exhausted: boolean;
        next_before: string | null;
      };
    };
    expect(historyBody.data.messages.map((message) => message.text)).toEqual(
      expect.arrayContaining(['historical room A', 'new room A']),
    );
    expect(historyBody.data.messages.every((message) => message.agent_name === 'alice')).toBe(true);
    expect(
      historyBody.data.messages.every(
        (message) => Number.isFinite(Date.parse(message.created_at)) && message.created_at.endsWith('Z'),
      ),
    ).toBe(true);
    expect(historyBody.data.messages.map((message) => message.text)).not.toContain('private room B');
    expect(historyBody.data.exhausted).toBe(true);

    // Pagination metadata is based on the raw page, so an agent filter cannot
    // make an empty visible page look exhausted while older allowed rows exist.
    await sendDm(stack, bob.token, 'alice', 'newest hidden by agent filter');
    const aliceOnly = await mintConnectObserver(
      stack,
      roomA.workspaceKey,
      'connect-observer-alice-only',
      { include_dms: true, agent_ids: [alice.agentId] },
    );
    const filteredConversations = await stack.app.request('/v1/dm/conversations/all', {
      headers: { authorization: `Bearer ${aliceOnly.token}` },
    });
    expect(filteredConversations.status).toBe(200);
    await expect(filteredConversations.json()).resolves.toMatchObject({
      data: [{ id: historicalA.data.conversation_id, last_message: null }],
    });
    const hiddenRawPage = await stack.app.request(
      `/v1/dm/conversations/${historicalA.data.conversation_id}/messages?limit=1&page=1`,
      { headers: { authorization: `Bearer ${aliceOnly.token}` } },
    );
    const hiddenRawPageBody = (await hiddenRawPage.json()) as {
      data: { messages: unknown[]; next_before: string; exhausted: boolean };
    };
    expect(hiddenRawPageBody.data).toMatchObject({ messages: [], exhausted: false });
    const olderAllowedPage = await stack.app.request(
      `/v1/dm/conversations/${historicalA.data.conversation_id}/messages?limit=1&page=1&before=${hiddenRawPageBody.data.next_before}`,
      { headers: { authorization: `Bearer ${aliceOnly.token}` } },
    );
    await expect(olderAllowedPage.json()).resolves.toMatchObject({
      data: { messages: [{ agent_name: 'alice' }] },
    });

    const dmMessagesBeforeWrites = await stack.runtime.deps.db
      .select()
      .from(messages)
      .where(eq(messages.workspaceId, roomA.workspaceId));

    const sendDenied = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${observer.token}`,
      },
      body: JSON.stringify({ to: 'bob', text: 'observer must not send' }),
    });
    expect(sendDenied.status).toBe(401);
    await expect(sendDenied.json()).resolves.toMatchObject({
      error: { code: 'observer_token_forbidden' },
    });

    const replyDenied = await stack.app.request(`/v1/dm/${historicalA.data.conversation_id}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${observer.token}`,
      },
      body: JSON.stringify({ text: 'observer must not reply' }),
    });
    expect(replyDenied.status).toBe(401);
    await expect(replyDenied.json()).resolves.toMatchObject({
      error: { code: 'observer_token_forbidden' },
    });

    const dmMessagesAfterWrites = await stack.runtime.deps.db
      .select()
      .from(messages)
      .where(eq(messages.workspaceId, roomA.workspaceId));
    expect(dmMessagesAfterWrites).toHaveLength(dmMessagesBeforeWrites.length);

    const crossRoom = await stack.app.request(
      `/v1/dm/conversations/${privateB.data.conversation_id}/messages?limit=100`,
      { headers: { authorization: `Bearer ${observer.token}` } },
    );
    expect(crossRoom.status).toBe(404);

    await stack.runtime.deps.db
      .update(observerTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(observerTokens.id, observer.id));
    expect(
      (
        await stack.app.request('/v1/workspace', {
          headers: { authorization: `Bearer ${observer.token}` },
        })
      ).status,
    ).toBe(401);

    const revoked = await mintConnectObserver(stack, roomA.workspaceKey, 'connect-observer-revoked');
    expect(
      (
        await stack.app.request(`/v1/observer-tokens/${revoked.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${roomA.workspaceKey}` },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await stack.app.request('/v1/workspace', {
          headers: { authorization: `Bearer ${revoked.token}` },
        })
      ).status,
    ).toBe(401);

    const ended = await mintConnectObserver(stack, roomA.workspaceKey, 'connect-observer-ended');
    expect(
      (
        await stack.app.request(`/v1/workspaces/${roomA.workspaceId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${roomA.workspaceKey}` },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await stack.app.request('/v1/workspace', {
          headers: { authorization: `Bearer ${ended.token}` },
        })
      ).status,
    ).toBe(401);
  });
});
