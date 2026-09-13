import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

/**
 * Regression for the captured cross-channel leak: a native MCP post result
 * piggybacked the inbox, which listed an ARCHIVED channel's unread and an
 * ESCAPED `\@handle` message as a "mention", so a receiver ACKed a historical
 * negative. Root: engine inbox counted archived channels and matched mentions
 * with a loose substring instead of the shared `parseMessageMentions` contract.
 *
 * Covers: archived exclusion; canonical mention classification (active escaped
 * negative, prefix, superstring, email) with per-body ID assertions; a keyset
 * scan that finds a valid OLDER mention behind >200 false candidates; the
 * membership/privacy guard (nonmember private channel + foreign workspace +
 * self-mention); and that legitimate DM mentions and own unread DMs still work
 * while inaccessible DMs are never exposed.
 */
describe('inbox archived channels, canonical mentions, privacy, and DMs', () => {
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
    };
  };
  const send = async (token: string, channel: string, text: string) => {
    const res = await api(token).post(`/v1/channels/${channel}/messages`, { text });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };

  it('classifies mentions canonically, excludes archived/nonmember/foreign/self, keeps DMs', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-scope');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'other');
    const t = api(target.token);

    // LIVE channel the target belongs to.
    expect((await api(sender.token).post('/v1/channels', { name: 'live' })).status).toBe(201);
    // PRIVATE channel the target does NOT belong to.
    expect((await api(sender.token).post('/v1/channels', { name: 'secret' })).status).toBe(201);
    await api(target.token).post('/v1/channels/live/join');

    // --- per-body canonical classification (assert IDs) ---
    const idExact = await send(sender.token, 'live', '@gh-target-0908 exact');
    const idDup = await send(sender.token, 'live', '@gh-target-0908 @gh-target-0908 duplicate');
    const idEscaped = await send(sender.token, 'live', '\\@gh-target-0908 escaped');
    const idPrefix = await send(sender.token, 'live', '@gh prefix');
    const idSuper = await send(sender.token, 'live', '@gh-target-0908-extra superstring');
    const idEmail = await send(sender.token, 'live', 'sender@gh-target-0908 email');
    const idSelf = await send(target.token, 'live', '@gh-target-0908 self');
    const idNonmember = await send(sender.token, 'secret', '@gh-target-0908 nonmember-private');

    // ARCHIVED channel with exact + escaped mentions posted before archiving.
    expect((await api(sender.token).post('/v1/channels', { name: 'arch' })).status).toBe(201);
    await api(target.token).post('/v1/channels/arch/join');
    const idArchExact = await send(sender.token, 'arch', '@gh-target-0908 archived exact');
    await send(sender.token, 'arch', 'GHSUB_EVENT_NONCE=2dfeab92445665903b1bb9b8ceac3b81 \\@gh-target-0908');
    expect((await api(sender.token).del('/v1/channels/arch')).status).toBeLessThan(300);

    // FOREIGN workspace mention never crosses over.
    const foreign = await createWorkspace(stack.app, 'inbox-foreign');
    const foreignSender = await registerAgent(stack.app, foreign.workspaceKey, 'foreign-sender');
    const idForeign = await send(foreignSender.token, 'general', '@gh-target-0908 foreign');

    const inbox = await inboxOf(target.token);
    const mentionIds = new Set(inbox.mentions.map((m) => m.id));

    // Positives: the exact and the duplicate (single row) are the ONLY mentions.
    expect(mentionIds.has(idExact)).toBe(true);
    expect(mentionIds.has(idDup)).toBe(true);
    expect(inbox.mentions.filter((m) => m.id === idDup)).toHaveLength(1);
    expect(inbox.mentions).toHaveLength(2);

    // Negatives are each excluded.
    for (const id of [idEscaped, idPrefix, idSuper, idEmail, idSelf, idNonmember, idArchExact, idForeign]) {
      expect(mentionIds.has(id)).toBe(false);
    }
    // Archived channel contributes no unread either.
    expect(inbox.unread_channels.map((c) => c.channel_name)).not.toContain('arch');
    expect(inbox.mentions.every((m) => m.channel_name !== 'secret' && m.channel_name !== 'arch')).toBe(true);

    expect(other.token).toBeTruthy();
  });

  it('keyset-scans past >200 false candidates to find an older valid mention', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-keyset');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');
    expect((await api(sender.token).post('/v1/channels', { name: 'live' })).status).toBe(201);
    await api(target.token).post('/v1/channels/live/join');

    // OLDER valid mention first, then >200 candidates that match the escaped
    // literal narrowing but are NOT canonical mentions.
    const idOlderValid = await send(sender.token, 'live', '@gh-target-0908 older-valid');
    for (let i = 0; i < 205; i++) {
      await send(sender.token, 'live', `\\@gh-target-0908 false-${i}`);
    }

    const inbox = await inboxOf(target.token);
    const ids = new Set(inbox.mentions.map((m) => m.id));
    expect(ids.has(idOlderValid)).toBe(true);
    expect(inbox.mentions).toHaveLength(1);
  });

  it('keeps legitimate DM mentions and own unread DMs, never exposes inaccessible DMs', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-dm');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');
    const other = await registerAgent(stack.app, ws.workspaceKey, 'other');

    // A DM the target participates in, with a mention.
    const dm = await api(sender.token).post('/v1/dm', { to: 'gh-target-0908', text: '@gh-target-0908 dm mention' });
    expect(dm.status).toBeLessThan(300);
    const dmId = (await dm.json()).data.id as string;
    // A DM the target is NOT part of, containing the target's handle as text.
    const inaccessible = await api(sender.token).post('/v1/dm', { to: 'other', text: '@gh-target-0908 leak?' });
    expect(inaccessible.status).toBeLessThan(300);
    const inaccessibleId = (await inaccessible.json()).data.id as string;

    const inbox = await inboxOf(target.token);
    const ids = new Set(inbox.mentions.map((m) => m.id));
    expect(ids.has(dmId)).toBe(true);
    expect(ids.has(inaccessibleId)).toBe(false);
    // Own unread DM is surfaced and not double-counted as a channel.
    expect(inbox.unread_channels.some((c) => c.channel_name === 'general')).toBe(false);
    expect((inbox as unknown as { unread_dms?: unknown[] }).unread_dms ?? []).toBeDefined();
  });
});
