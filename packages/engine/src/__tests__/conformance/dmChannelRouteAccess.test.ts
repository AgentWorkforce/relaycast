import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

// DM and group-DM conversations live on ordinary channel rows, so the
// channel/message/search/console routes reach them. An agent that is not a
// participant must see none of it, and must not be able to write into it.

interface Envelope<T> { ok: boolean; data: T; error?: { code: string } }

describe('DM content through channel and message routes', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function call<T = unknown>(method: string, path: string, token: string, body?: unknown) {
    const res = await stack.app.request(`/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as Envelope<T>;
    return { status: res.status, data: json.data, text };
  }

  async function setup() {
    const ws = await createWorkspace(stack.app, 'dm-route-access-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const dave = await registerAgent(stack.app, ws.workspaceKey, 'dave');

    const dm = await call<{ id: string; conversation_id: string }>(
      'POST', '/dm', alice.token, { to: 'bob', text: 'pairsecret one' },
    );
    expect(dm.status).toBe(201);
    const group = await call<{ id: string }>(
      'POST', '/dm/group', alice.token, { participants: ['bob', 'dave'], name: 'private' },
    );
    expect(group.status).toBe(201);
    const groupMessage = await call<{ id: string }>(
      'POST', `/dm/${group.data.id}/messages`, alice.token, { text: 'groupsecret two' },
    );
    expect(groupMessage.status).toBe(201);

    // The workspace key is the admin view; use it to learn the backing channel names.
    const all = await call<Array<{ id: string; type: string }>>('GET', '/dm/conversations/all', ws.workspaceKey);
    const pairConversationId = all.data.find((conversation) => conversation.type === '1:1')!.id;
    const pairChannel = `dm-${pairConversationId.replace(/^dm_/, '')}`;
    const groupChannel = `group-dm-${group.data.id}`;

    return {
      ws, alice, bob, carol, dave,
      pair: { channel: pairChannel, conversationId: pairConversationId, messageId: String(dm.data.id) },
      group: { channel: groupChannel, conversationId: group.data.id, messageId: String(groupMessage.data.id) },
    };
  }

  it('hides DM-backed channels and their messages from a non-participant agent', async () => {
    const { carol, pair, group } = await setup();

    for (const target of [pair, group]) {
      for (const path of [
        `/channels/${target.channel}`,
        `/channels/${target.channel}/messages`,
        `/channels/${target.channel}/members`,
        `/channels/${target.channel}/read-status`,
        `/messages/${target.messageId}`,
        `/messages/${target.messageId}/replies`,
        `/messages/${target.messageId}/reactions`,
        `/messages/${target.messageId}/readers`,
      ]) {
        const res = await call('GET', path, carol.token);
        expect(res.status, `GET ${path}`).toBe(404);
        expect(res.text).not.toContain('secret');
      }
    }
  });

  it('keeps DM content out of search and console logs for a non-participant agent', async () => {
    const { carol, bob, alice } = await setup();
    const publicPost = await call('POST', '/channels/general/messages', alice.token, { text: 'pairsecret in public' });
    expect(publicPost.status).toBe(201);

    for (const q of ['pairsecret', 'groupsecret']) {
      const outsider = await call<Array<{ text: string; conversation_id: string | null }>>(
        'GET', `/search?q=${q}`, carol.token,
      );
      expect(outsider.status).toBe(200);
      expect(outsider.data.every((hit) => !hit.conversation_id)).toBe(true);
      expect(outsider.text).not.toContain('one');
      expect(outsider.text).not.toContain('two');
    }
    // Regular channel hits are unaffected.
    const publicHits = await call<Array<{ text: string }>>('GET', '/search?q=pairsecret', carol.token);
    expect(publicHits.data.map((hit) => hit.text)).toEqual(['pairsecret in public']);

    const participant = await call<Array<{ text: string }>>('GET', '/search?q=groupsecret', bob.token);
    expect(participant.data.map((hit) => hit.text)).toContain('groupsecret two');

    const outsiderLogs = await call<Array<{ conversation_id?: string | null }>>(
      'GET', '/console/messages', carol.token,
    );
    expect(outsiderLogs.status).toBe(200);
    expect(outsiderLogs.data.length).toBeGreaterThan(0);
    expect(outsiderLogs.data.every((log) => !log.conversation_id)).toBe(true);
    const dmOnly = await call<unknown[]>('GET', '/console/messages?delivery_kind=dm', carol.token);
    expect(dmOnly.data).toHaveLength(0);

    const participantLogs = await call<Array<{ conversation_id?: string | null }>>(
      'GET', '/console/messages?delivery_kind=dm', bob.token,
    );
    expect(participantLogs.data.length).toBeGreaterThan(0);
  });

  it('refuses writes into a DM by a non-participant agent', async () => {
    const { bob, carol, pair, group } = await setup();

    for (const target of [pair, group]) {
      const writes: Array<[string, string, unknown?]> = [
        ['POST', `/channels/${target.channel}/messages`, { text: 'injected' }],
        ['POST', `/channels/${target.channel}/join`],
        ['POST', `/channels/${target.channel}/leave`],
        ['POST', `/channels/${target.channel}/invite`, { agent_name: 'carol' }],
        ['POST', `/channels/${target.channel}/mute`],
        ['PATCH', `/channels/${target.channel}`, { topic: 'x' }],
        ['DELETE', `/channels/${target.channel}`],
        ['POST', `/messages/${target.messageId}/replies`, { text: 'injected' }],
        ['POST', `/messages/${target.messageId}/reactions`, { emoji: 'eyes' }],
        ['POST', `/messages/${target.messageId}/read`],
      ];
      for (const [method, path, body] of writes) {
        const res = await call(method, path, carol.token, body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }

      const history = await call('GET', `/dm/${target.conversationId}/messages`, bob.token);
      expect(history.status).toBe(200);
      expect(history.text).not.toContain('injected');
    }
  });

  it('does not let a participant pull an outsider in through channel membership', async () => {
    const { alice, carol, pair, group } = await setup();

    for (const target of [pair, group]) {
      const join = await call('POST', `/channels/${target.channel}/join`, alice.token);
      expect(join.status).toBe(404);
      const invite = await call('POST', `/channels/${target.channel}/invite`, alice.token, { agent_name: 'carol' });
      expect(invite.status).toBe(404);
      const stillHidden = await call('GET', `/channels/${target.channel}/messages`, carol.token);
      expect(stillHidden.status).toBe(404);
    }
  });

  it('leaves participants and the workspace key able to read by channel name and message id', async () => {
    const { ws, bob, pair, group } = await setup();

    for (const token of [bob.token, ws.workspaceKey]) {
      for (const target of [pair, group]) {
        const history = await call('GET', `/channels/${target.channel}/messages`, token);
        expect(history.status).toBe(200);
        expect(history.text).toContain('secret');
        const message = await call('GET', `/messages/${target.messageId}`, token);
        expect(message.status).toBe(200);
      }
    }
  });

  it('stops applying once a participant has left a group DM', async () => {
    const { dave, group } = await setup();
    const before = await call('GET', `/messages/${group.messageId}`, dave.token);
    expect(before.status).toBe(200);

    const leave = await call('DELETE', `/dm/${group.conversationId}/participants/dave`, dave.token);
    expect(leave.status).toBeLessThan(300);

    const after = await call('GET', `/messages/${group.messageId}`, dave.token);
    expect(after.status).toBe(404);
  });
});
