import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

/**
 * Regression for the captured cross-channel leak: a native MCP post result
 * piggybacked the inbox, which listed an ARCHIVED channel's unread and an
 * ESCAPED `\@handle` message as a "mention" — so a receiver ACKed a historical
 * negative nonce. Root: engine inbox counted archived channels and matched
 * mentions with a loose `LIKE '%@name%'` instead of the shared
 * `parseMessageMentions` contract.
 */
describe('inbox excludes archived channels and matches mentions canonically', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  it('keeps live exact mentions, drops archived/escaped/prefix/superstring', async () => {
    const ws = await createWorkspace(stack.app, 'inbox-archived');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'sender');
    const target = await registerAgent(stack.app, ws.workspaceKey, 'gh-target-0908');
    const prefix = await registerAgent(stack.app, ws.workspaceKey, 'gh');
    const request = (path: string, token: string, method = 'POST', body?: unknown) =>
      stack.app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // A LIVE channel the target belongs to.
    expect((await request('/v1/channels', sender.token, 'POST', { name: 'live' })).status).toBe(201);
    await request('/v1/channels/live/join', target.token);
    expect((await request('/v1/channels/live/join', prefix.token)).status).toBeLessThan(300);

    // An ARCHIVED channel where an EXACT mention and an ESCAPED nonce were posted
    // before archiving (the captured 2dfeab negative).
    expect((await request('/v1/channels', sender.token, 'POST', { name: 'arch' })).status).toBe(201);
    await request('/v1/channels/arch/join', target.token);
    await request('/v1/channels/arch/messages', sender.token, 'POST', { text: '@gh-target-0908 please ignore' });
    await request('/v1/channels/arch/messages', sender.token, 'POST', {
      text: 'GHSUB_EVENT_NONCE=2dfeab92445665903b1bb9b8ceac3b81 \\@gh-target-0908',
    });
    expect((await request('/v1/channels/arch', sender.token, 'DELETE')).status).toBeLessThan(300);

    // LIVE channel: exact, duplicate, escaped, prefix, superstring, email.
    const post = await request('/v1/channels/live/messages', sender.token, 'POST', {
      text: '@gh-target-0908 @gh-target-0908 \\@gh-target-0908 @gh @gh-target-0908-extra sender@gh-target-0908',
    });
    expect(post.status).toBe(201);

    const res = await request('/v1/inbox', target.token, 'GET');
    expect(res.status).toBe(200);
    const inbox = (await res.json()).data as {
      unread_channels: Array<{ channel_name: string }>;
      mentions: Array<{ channel_name: string; text: string }>;
    };

    // Archived channel is excluded from unread counts AND mentions.
    expect(inbox.unread_channels.map((c) => c.channel_name)).not.toContain('arch');
    expect(inbox.mentions.every((m) => m.channel_name !== 'arch')).toBe(true);
    expect(inbox.mentions.some((m) => m.text.includes('2dfeab'))).toBe(false);

    // Only the exact LIVE handle is a mention; escaped/prefix/superstring/email are not.
    expect(inbox.mentions).toHaveLength(1);
    expect(inbox.mentions[0].channel_name).toBe('live');
  });
});
