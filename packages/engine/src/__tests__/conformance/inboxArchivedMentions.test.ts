import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

/**
 * Regression for the captured cross-channel leak: a native MCP post result
 * piggybacked the inbox, which listed an ARCHIVED channel's unread and an
 * ESCAPED `\@handle` message as a "mention", so a receiver ACKed a historical
 * negative. Root: engine inbox counted archived channels and matched mentions
 * with a loose substring instead of the shared `parseMessageMentions` contract.
 *
 * Channel access is MEMBERSHIP-scoped: `POST /v1/channels` accepts only
 * {name, topic, metadata} (no private flag), so privacy is proven by a
 * non-member never seeing the mention.
 */
describe('inbox mention scope', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  const api = (token: string) => ({
    post: (path: string, body?: unknown) =>
      stack.app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    get: (path: string) => stack.app.request(path, { headers: { authorization: `Bearer ${token}` } }),
    del: (path: string) => stack.app.request(path, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }),
  });
  const inboxOf = async (token: string) => {
    const res = await api(token).get('/v1/inbox');
    expect(res.status).toBe(200);
    return (await res.json()).data as {
      unread_channels: Array<{ channel_name: string; unread_count: number }>;
      mentions: Array<{ id: string; channel_name: string; text: string }>;
      unread_dms: Array<{ conversation_id: string; from: string; unread_count: number }>;
    };
  };
  const send = async (token: string, channel: string, text: string) => {
    const res = await api(token).post(`/v1/channels/${channel}/messages`, { text });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  const joinOk = async (token: string, channel: string) => {
    const res = await api(token).post(`/v1/channels/${channel}/join`);
    expect([200, 201]).toContain(res.status);
  };

  it('classifies mentions canonically and excludes archived/nonmember/foreign/self', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-scope');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');

    // LIVE channel the target joins.
    expect((await api(sender.token).post('/v1/channels', { name: 'live' })).status).toBe(201);
    // A channel the target does NOT join (membership-scoped access).
    const secretRes = await api(sender.token).post('/v1/channels', { name: 'nonmember' });
    expect(secretRes.status).toBe(201);
    const secret = (await secretRes.json()).data as { id: string; name: string };
    expect(typeof secret.id).toBe('string');
    expect(secret.name).toBe('nonmember');
    await joinOk(target.token, 'live');

    // Assert the target is really absent from the non-member channel BEFORE the negative.
    const membersRes = await api(sender.token).get('/v1/channels/nonmember/members');
    expect(membersRes.status).toBe(200);
    const secretMembers = (await membersRes.json()).data as Array<{ agent_id?: string; agent_name?: string }>;
    expect(secretMembers.some((m) => m.agent_name === 'gh-target-0908')).toBe(false);

    // --- per-body canonical classification (assert IDs) ---
    const idExact = await send(sender.token, 'live', '@gh-target-0908 exact');
    const idDup = await send(sender.token, 'live', '@gh-target-0908 @gh-target-0908 duplicate');
    const idEscaped = await send(sender.token, 'live', '\\@gh-target-0908 escaped');
    const idPrefix = await send(sender.token, 'live', '@gh prefix');
    const idSuper = await send(sender.token, 'live', '@gh-target-0908-extra superstring');
    const idEmail = await send(sender.token, 'live', 'sender@gh-target-0908 email');
    const idSelf = await send(target.token, 'live', '@gh-target-0908 self');
    const idNonmember = await send(sender.token, 'nonmember', '@gh-target-0908 nonmember');

    // ARCHIVED channel: exact + escaped mentions posted before archiving.
    expect((await api(sender.token).post('/v1/channels', { name: 'arch' })).status).toBe(201);
    await joinOk(target.token, 'arch');
    const idArchExact = await send(sender.token, 'arch', '@gh-target-0908 archived exact');
    await send(sender.token, 'arch', 'GHSUB_EVENT_NONCE=2dfeab92445665903b1bb9b8ceac3b81 \\@gh-target-0908');
    expect((await api(sender.token).del('/v1/channels/arch')).status).toBeLessThan(300);

    // FOREIGN workspace mention never crosses over.
    const foreign = await createWorkspace(stack.app, 'inbox-foreign');
    const foreignSender = await registerAgent(stack.app, foreign.workspaceKey, 'foreign-sender');
    const foreignChannel = 'general';
    const idForeign = await send(foreignSender.token, foreignChannel, '@gh-target-0908 foreign');

    const inbox = await inboxOf(target.token);
    const mentionIds = new Set(inbox.mentions.map((m) => m.id));

    // Positives: exact + the single duplicate row.
    expect(mentionIds.has(idExact)).toBe(true);
    expect(mentionIds.has(idDup)).toBe(true);
    expect(inbox.mentions.filter((m) => m.id === idDup)).toHaveLength(1);
    expect(inbox.mentions).toHaveLength(2);

    // Negatives are each excluded.
    for (const id of [idEscaped, idPrefix, idSuper, idEmail, idSelf, idNonmember, idArchExact, idForeign]) {
      expect(mentionIds.has(id)).toBe(false);
    }
    expect(inbox.mentions.every((m) => m.channel_name !== 'nonmember' && m.channel_name !== 'arch')).toBe(true);
    expect(inbox.unread_channels.map((c) => c.channel_name)).not.toContain('arch');
  });

  it('keyset-scans past >200 false candidates to find an older valid mention', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-keyset');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');
    expect((await api(sender.token).post('/v1/channels', { name: 'live' })).status).toBe(201);
    await joinOk(target.token, 'live');

    // OLDER valid mention first, then >200 candidates matching the escaped-literal
    // narrowing but not canonical mentions.
    const idOlderValid = await send(sender.token, 'live', '@gh-target-0908 older-valid');
    for (let i = 0; i < 205; i++) {
      await send(sender.token, 'live', `\\@gh-target-0908 false-${i}`);
    }

    const inbox = await inboxOf(target.token);
    const ids = new Set(inbox.mentions.map((m) => m.id));
    expect(ids.has(idOlderValid)).toBe(true);
    expect(inbox.mentions).toHaveLength(1);
  });
});

describe('inbox DM scope', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  const authed = (token: string) => ({
    post: (path: string, body?: unknown) =>
      stack.app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    get: (path: string) => stack.app.request(path, { headers: { authorization: `Bearer ${token}` } }),
  });

  it('keeps own DM mentions + unread, never exposes an inaccessible DM', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-dm');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'other');

    const ownDmRes = await authed(sender.token).post('/v1/dm', { to: 'gh-target-0908', text: '@gh-target-0908 dm mention' });
    expect(ownDmRes.status).toBeLessThan(300);
    const ownDm = (await ownDmRes.json()).data as { id: string; conversation_id: string };
    expect(typeof ownDm.conversation_id).toBe('string');

    const otherDmRes = await authed(sender.token).post('/v1/dm', { to: 'other', text: '@gh-target-0908 leak?' });
    expect(otherDmRes.status).toBeLessThan(300);
    const otherDm = (await otherDmRes.json()).data as { id: string; conversation_id: string };
    expect(otherDm.conversation_id).not.toBe(ownDm.conversation_id);

    const res = await authed(target.token).get('/v1/inbox');
    expect(res.status).toBe(200);
    const inbox = (await res.json()).data as {
      mentions: Array<{ id: string }>;
      unread_dms: Array<{ conversation_id: string; from: string; unread_count: number }>;
    };

    // Own DM mention + unread are surfaced with exact identity/counter.
    expect(inbox.mentions.some((m) => m.id === ownDm.id)).toBe(true);
    const own = inbox.unread_dms.find((d) => d.conversation_id === ownDm.conversation_id);
    expect(own).toBeDefined();
    expect(own!.from).toBe('sender');
    expect(own!.unread_count).toBeGreaterThanOrEqual(1);
    // Inaccessible DM is never exposed — neither its unread row NOR its message
    // as a mention.
    expect(inbox.unread_dms.some((d) => d.conversation_id === otherDm.conversation_id)).toBe(false);
    expect(inbox.mentions.some((m) => m.id === otherDm.id)).toBe(false);
    expect(other.token).toBeTruthy();
  });
});
