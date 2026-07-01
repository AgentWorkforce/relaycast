import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { channels, messageLogs, messages, observerTokens } from '../../db/schema.js';
import { authenticateRealtimeWs } from '../../engine/wsAuth.js';

async function createObserverToken(
  stack: TestStack,
  workspaceKey: string,
  body: Record<string, unknown>,
) {
  const res = await stack.app.request('/v1/observer-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify(body),
  });
  const json = await res.json() as {
    data?: { id: string; token?: string; scopes: string[]; filters: Record<string, unknown> };
    error?: { code: string; message: string };
  };
  return { res, data: json.data!, body: json };
}

function dmChannelName(workspaceId: string, agentA: string, agentB: string): string {
  const [first, second] = [agentA, agentB].sort();
  const pairKey = createHash('sha256')
    .update(`${workspaceId}:${first}:${second}`)
    .digest('hex')
    .slice(0, 24);
  return `dm-${pairKey}`;
}

async function uploadCompletedFile(stack: TestStack, token: string, filename: string) {
  const upload = await stack.app.request('/v1/files/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      filename,
      content_type: 'text/plain',
      size_bytes: 12,
    }),
  });
  expect(upload.status).toBe(201);
  const uploadBody = await upload.json() as { data: { id: string } };
  const complete = await stack.app.request(`/v1/files/${uploadBody.data.id}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(complete.status).toBe(200);
  return uploadBody.data.id;
}

describe('observer tokens', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('mints, lists, rotates, and revokes observer tokens without exposing token material after create/rotate', async () => {
    const ws = await createWorkspace(stack.app, 'observer-lifecycle-ws');
    const created = await createObserverToken(stack, ws.workspaceKey, {
      name: 'dashboard',
      description: 'Read-only dashboard',
      scopes: ['stream:read', 'channels:read'],
      filters: { channel_names: ['general'] },
    });

    expect(created.res.status).toBe(201);
    expect(created.data.token).toMatch(/^ot_live_/);
    expect(created.data.filters).toMatchObject({ include_dms: false, channel_names: ['general'] });

    const list = await stack.app.request('/v1/observer-tokens', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const listed = await list.json() as { data: Array<{ id: string; token?: string }> };
    expect(list.status).toBe(200);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].id).toBe(created.data.id);
    expect(listed.data[0].token).toBeUndefined();

    await stack.runtime.deps.db
      .update(observerTokens)
      .set({ scopes: ['stream:read', 'retired:read'] })
      .where(eq(observerTokens.id, created.data.id));
    const legacyScope = await stack.app.request(`/v1/observer-tokens/${created.data.id}`, {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const legacyScopeBody = await legacyScope.json() as { data: { scopes: string[] } };
    expect(legacyScope.status).toBe(200);
    expect(legacyScopeBody.data.scopes).toEqual(['stream:read']);

    const rotate = await stack.app.request(`/v1/observer-tokens/${created.data.id}/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const rotated = await rotate.json() as { data: { token?: string } };
    expect(rotate.status).toBe(200);
    expect(rotated.data.token).toMatch(/^ot_live_/);
    expect(rotated.data.token).not.toBe(created.data.token);

    const revoke = await stack.app.request(`/v1/observer-tokens/${created.data.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(revoke.status).toBe(204);

    const revokeAgain = await stack.app.request(`/v1/observer-tokens/${created.data.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(revokeAgain.status).toBe(404);

    const rotateRevoked = await stack.app.request(`/v1/observer-tokens/${created.data.id}/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(rotateRevoked.status).toBe(404);

    const updateRevoked = await stack.app.request(`/v1/observer-tokens/${created.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ description: 'should not update revoked tokens' }),
    });
    expect(updateRevoked.status).toBe(404);
  });

  it('rejects non-ISO observer token timestamps', async () => {
    const ws = await createWorkspace(stack.app, 'observer-timestamp-validation-ws');
    const res = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        name: 'bad-time',
        scopes: ['messages:read'],
        expires_at: 'June 1, 2026',
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });

    const expired = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        name: 'already-expired',
        scopes: ['messages:read'],
        expires_at: '2000-01-01T00:00:00.000Z',
      }),
    });
    expect(expired.status).toBe(400);
    await expect(expired.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('returns a conflict for duplicate observer token names in one workspace', async () => {
    const ws = await createWorkspace(stack.app, 'observer-duplicate-name-ws');
    const created = await createObserverToken(stack, ws.workspaceKey, {
      name: 'dashboard',
      scopes: ['messages:read'],
    });
    expect(created.res.status).toBe(201);

    const duplicate = await createObserverToken(stack, ws.workspaceKey, {
      name: 'dashboard',
      scopes: ['messages:read'],
    });
    expect(duplicate.res.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      ok: false,
      error: { code: 'observer_token_name_conflict' },
    });
  });

  it('gates REST reads by scope and channel filters and rejects observer writes', async () => {
    const ws = await createWorkspace(stack.app, 'observer-rest-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const createTeam = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createTeam.status).toBe(201);

    const generalChannel = await stack.app.request('/v1/channels/general', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const generalChannelBody = await generalChannel.json() as { data: { id: string } };
    expect(generalChannel.status).toBe(200);

    const general = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'visible general message' }),
    });
    expect(general.status).toBe(201);
    const generalBody = await general.json() as { data: { id: string } };

    const bobGeneral = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ text: 'hidden bob message' }),
    });
    expect(bobGeneral.status).toBe(201);
    const bobGeneralBody = await bobGeneral.json() as { data: { id: string } };

    const team = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hidden team message' }),
    });
    expect(team.status).toBe(201);

    await stack.runtime.deps.db
      .update(messageLogs)
      .set({ metadata: { _cost: { total_usd: 3, total_tokens: 30 } } })
      .where(eq(messageLogs.messageId, generalBody.data.id));
    await stack.runtime.deps.db
      .update(messageLogs)
      .set({ metadata: { _cost: { total_usd: 7, total_tokens: 70 } } })
      .where(eq(messageLogs.messageId, bobGeneralBody.data.id));

    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'general-reader',
      scopes: ['messages:read', 'channels:read', 'search:read'],
      filters: { channel_names: ['general'] },
    });
    const token = observer.data.token!;

    const allowedMessages = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowedMessages.status).toBe(200);
    const allowedBody = await allowedMessages.json() as { data: Array<{ text: string }> };
    expect(allowedBody.data.map((message) => message.text)).toContain('visible general message');

    const deniedMessages = await stack.app.request('/v1/channels/team-chat/messages', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deniedMessages.status).toBe(404);

    const search = await stack.app.request('/v1/search?q=message', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.status).toBe(200);
    const searchBody = await search.json() as { data: Array<{ text: string; channel_name: string }> };
    expect(searchBody.data.map((result) => result.text)).toContain('visible general message');
    expect(searchBody.data.map((result) => result.text)).not.toContain('hidden team message');
    expect(searchBody.data.every((result) => result.channel_name === 'general')).toBe(true);

    const aliceOnly = await createObserverToken(stack, ws.workspaceKey, {
      name: 'alice-reader',
      scopes: ['messages:read', 'search:read'],
      filters: { channel_names: ['general'], agent_ids: [alice.agentId] },
    });
    const filteredMessages = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${aliceOnly.data.token}` },
    });
    const filteredBody = await filteredMessages.json() as { data: Array<{ text: string }> };
    expect(filteredMessages.status).toBe(200);
    expect(filteredBody.data.map((message) => message.text)).toContain('visible general message');
    expect(filteredBody.data.map((message) => message.text)).not.toContain('hidden bob message');

    const filteredSearch = await stack.app.request('/v1/search?q=message', {
      headers: { authorization: `Bearer ${aliceOnly.data.token}` },
    });
    const filteredSearchBody = await filteredSearch.json() as { data: Array<{ text: string }> };
    expect(filteredSearch.status).toBe(200);
    expect(filteredSearchBody.data.map((result) => result.text)).toContain('visible general message');
    expect(filteredSearchBody.data.map((result) => result.text)).not.toContain('hidden bob message');

    const consoleObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'console-general-alice',
      scopes: ['activity:read', 'agents:read'],
      filters: { channel_names: ['general'], agent_ids: [alice.agentId] },
    });
    const consoleStats = await stack.app.request('/v1/console/stats', {
      headers: { authorization: `Bearer ${consoleObserver.data.token}` },
    });
    const consoleStatsBody = await consoleStats.json() as { data: { total_messages: number; channel_messages: number } };
    expect(consoleStats.status).toBe(200);
    expect(consoleStatsBody.data.total_messages).toBe(1);
    expect(consoleStatsBody.data.channel_messages).toBe(1);

    const consoleDmOnly = await createObserverToken(stack, ws.workspaceKey, {
      name: 'console-general-dm-event-only',
      scopes: ['activity:read'],
      filters: { channel_names: ['general'], event_types: ['dm.received'] },
    });
    const consoleDmOnlyStats = await stack.app.request('/v1/console/stats', {
      headers: { authorization: `Bearer ${consoleDmOnly.data.token}` },
    });
    const consoleDmOnlyStatsBody = await consoleDmOnlyStats.json() as { data: { total_messages: number; channel_messages: number; dm_messages: number } };
    expect(consoleDmOnlyStats.status).toBe(200);
    expect(consoleDmOnlyStatsBody.data).toMatchObject({
      total_messages: 0,
      channel_messages: 0,
      dm_messages: 0,
    });

    const consoleAgents = await stack.app.request('/v1/console/agents', {
      headers: { authorization: `Bearer ${consoleObserver.data.token}` },
    });
    const consoleAgentsBody = await consoleAgents.json() as { data: Array<{ agent_id: string; message_count: number }> };
    expect(consoleAgents.status).toBe(200);
    expect(consoleAgentsBody.data).toHaveLength(1);
    expect(consoleAgentsBody.data[0]).toMatchObject({
      agent_id: alice.agentId,
      agent_name: 'alice',
      message_count: 1,
      channel_count: 1,
      dm_count: 0,
      last_message_at: expect.any(String),
    });

    const consoleCosts = await stack.app.request('/v1/console/costs', {
      headers: { authorization: `Bearer ${consoleObserver.data.token}` },
    });
    const consoleCostsBody = await consoleCosts.json() as { data: { totals: { total_cost_usd: number; total_tokens: number }; agents: Array<{ agent_id: string; total_cost_usd: number; total_tokens: number }> } };
    expect(consoleCosts.status).toBe(200);
    expect(consoleCostsBody.data.totals).toMatchObject({ total_cost_usd: 3, total_tokens: 30 });
    expect(consoleCostsBody.data.agents).toHaveLength(1);
    expect(consoleCostsBody.data.agents[0]).toMatchObject({ agent_id: alice.agentId, total_cost_usd: 3, total_tokens: 30 });

    const futureOnly = await createObserverToken(stack, ws.workspaceKey, {
      name: 'future-reader',
      scopes: ['messages:read', 'search:read', 'reactions:read'],
      filters: { channel_names: ['general'], created_after: '2999-01-01T00:00:00.000Z' },
    });
    const futureMessages = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${futureOnly.data.token}` },
    });
    const futureMessagesBody = await futureMessages.json() as { data: unknown[] };
    expect(futureMessages.status).toBe(200);
    expect(futureMessagesBody.data).toHaveLength(0);

    const futureSingle = await stack.app.request(`/v1/messages/${generalBody.data.id}`, {
      headers: { authorization: `Bearer ${futureOnly.data.token}` },
    });
    expect(futureSingle.status).toBe(404);

    const futureSearch = await stack.app.request('/v1/search?q=message', {
      headers: { authorization: `Bearer ${futureOnly.data.token}` },
    });
    const futureSearchBody = await futureSearch.json() as { data: unknown[] };
    expect(futureSearch.status).toBe(200);
    expect(futureSearchBody.data).toHaveLength(0);

    const event = await stack.app.request('/v1/agents/alice/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ type: 'log', payload: { message: 'old event' } }),
    });
    expect(event.status).toBe(201);
    const futureActivity = await createObserverToken(stack, ws.workspaceKey, {
      name: 'future-activity',
      scopes: ['activity:read'],
      filters: { agent_ids: [alice.agentId], created_after: '2999-01-01T00:00:00.000Z' },
    });
    const futureEvents = await stack.app.request('/v1/agents/alice/events', {
      headers: { authorization: `Bearer ${futureActivity.data.token}` },
    });
    const futureEventsBody = await futureEvents.json() as { data: unknown[] };
    expect(futureEvents.status).toBe(200);
    expect(futureEventsBody.data).toHaveLength(0);

    const channelIdActivity = await createObserverToken(stack, ws.workspaceKey, {
      name: 'general-activity-by-id',
      scopes: ['activity:read'],
      filters: { channel_ids: [generalChannelBody.data.id] },
    });
    const activity = await stack.app.request('/v1/activity', {
      headers: { authorization: `Bearer ${channelIdActivity.data.token}` },
    });
    const activityBody = await activity.json() as { data: Array<{ text: string; channel_id?: string }> };
    expect(activity.status).toBe(200);
    expect(activityBody.data.map((item) => item.text)).toContain('visible general message');
    expect(activityBody.data.map((item) => item.text)).toContain('hidden bob message');
    expect(activityBody.data.map((item) => item.text)).not.toContain('hidden team message');
    expect(activityBody.data.every((item) => item.channel_id === generalChannelBody.data.id)).toBe(true);

    const dmEventActivity = await createObserverToken(stack, ws.workspaceKey, {
      name: 'activity-dm-event-only',
      scopes: ['activity:read'],
      filters: { channel_ids: [generalChannelBody.data.id], event_types: ['dm.received'] },
    });
    const dmEventOnlyActivity = await stack.app.request('/v1/activity', {
      headers: { authorization: `Bearer ${dmEventActivity.data.token}` },
    });
    const dmEventOnlyActivityBody = await dmEventOnlyActivity.json() as { data: unknown[] };
    expect(dmEventOnlyActivity.status).toBe(200);
    expect(dmEventOnlyActivityBody.data).toHaveLength(0);

    const reactionsWithMessageScope = await stack.app.request(`/v1/messages/${generalBody.data.id}/reactions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reactionsWithMessageScope.status).toBe(403);

    const reactionsReader = await createObserverToken(stack, ws.workspaceKey, {
      name: 'reaction-reader',
      scopes: ['reactions:read'],
      filters: { channel_names: ['general'] },
    });
    const reactionsWithReactionScope = await stack.app.request(`/v1/messages/${generalBody.data.id}/reactions`, {
      headers: { authorization: `Bearer ${reactionsReader.data.token}` },
    });
    expect(reactionsWithReactionScope.status).toBe(200);

    const futureReactions = await stack.app.request(`/v1/messages/${generalBody.data.id}/reactions`, {
      headers: { authorization: `Bearer ${futureOnly.data.token}` },
    });
    expect(futureReactions.status).toBe(404);

    const write = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'must not write' }),
    });
    expect(write.status).toBe(401);
  });

  it('requires the right read scopes and enforces DM opt-in filters', async () => {
    const ws = await createWorkspace(stack.app, 'observer-dm-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const dm = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ to: 'bob', text: 'private note' }),
    });
    expect(dm.status).toBe(201);

    const noDm = await createObserverToken(stack, ws.workspaceKey, {
      name: 'no-dms',
      scopes: ['dms:read'],
      filters: { include_dms: false },
    });
    const hidden = await stack.app.request('/v1/dm/conversations/all', {
      headers: { authorization: `Bearer ${noDm.data.token}` },
    });
    const hiddenBody = await hidden.json() as { data: unknown[] };
    expect(hidden.status).toBe(200);
    expect(hiddenBody.data).toHaveLength(0);

    const withDm = await createObserverToken(stack, ws.workspaceKey, {
      name: 'with-dms',
      scopes: ['dms:read'],
      filters: { include_dms: true },
    });
    const visible = await stack.app.request('/v1/dm/conversations/all', {
      headers: { authorization: `Bearer ${withDm.data.token}` },
    });
    const visibleBody = await visible.json() as { data: Array<{ id: string }> };
    expect(visible.status).toBe(200);
    expect(visibleBody.data).toHaveLength(1);

    const derivedDmChannelName = dmChannelName(ws.workspaceId, alice.agentId, bob.agentId);
    const channelPathObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'channel-path-dm-bypass',
      scopes: ['messages:read', 'channels:read'],
    });
    const channelPathMessages = await stack.app.request(`/v1/channels/${derivedDmChannelName}/messages`, {
      headers: { authorization: `Bearer ${channelPathObserver.data.token}` },
    });
    expect(channelPathMessages.status).toBe(404);

    const channelPathDetails = await stack.app.request(`/v1/channels/${derivedDmChannelName}`, {
      headers: { authorization: `Bearer ${channelPathObserver.data.token}` },
    });
    expect(channelPathDetails.status).toBe(404);

    const channelPathMembers = await stack.app.request(`/v1/channels/${derivedDmChannelName}/members`, {
      headers: { authorization: `Bearer ${channelPathObserver.data.token}` },
    });
    expect(channelPathMembers.status).toBe(404);

    const dmSearchWithoutScope = await createObserverToken(stack, ws.workspaceKey, {
      name: 'dm-search-without-scope',
      scopes: ['search:read'],
      filters: { include_dms: true },
    });
    const hiddenSearch = await stack.app.request('/v1/search?q=private', {
      headers: { authorization: `Bearer ${dmSearchWithoutScope.data.token}` },
    });
    const hiddenSearchBody = await hiddenSearch.json() as { data: unknown[] };
    expect(hiddenSearch.status).toBe(200);
    expect(hiddenSearchBody.data).toHaveLength(0);

    const dmSearchWithScope = await createObserverToken(stack, ws.workspaceKey, {
      name: 'dm-search-with-scope',
      scopes: ['search:read', 'dms:read'],
      filters: { include_dms: true },
    });
    const visibleSearch = await stack.app.request('/v1/search?q=private', {
      headers: { authorization: `Bearer ${dmSearchWithScope.data.token}` },
    });
    const visibleSearchBody = await visibleSearch.json() as { data: Array<{ text: string }> };
    expect(visibleSearch.status).toBe(200);
    expect(visibleSearchBody.data.map((result) => result.text)).toContain('private note');

    await stack.runtime.deps.db.insert(channels).values({
      id: 'orphan_private_channel',
      workspaceId: ws.workspaceId,
      name: 'orphan-private-channel',
      channelType: 1,
    });
    await stack.runtime.deps.db.insert(messages).values({
      id: 'orphan_private_message',
      workspaceId: ws.workspaceId,
      channelId: 'orphan_private_channel',
      agentId: alice.agentId,
      body: 'orphan private body',
    });
    const orphanMessageObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'orphan-message-reader',
      scopes: ['messages:read'],
    });
    const orphanMessage = await stack.app.request('/v1/messages/orphan_private_message', {
      headers: { authorization: `Bearer ${orphanMessageObserver.data.token}` },
    });
    expect(orphanMessage.status).toBe(404);

    const orphanReactionObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'orphan-reaction-reader',
      scopes: ['reactions:read'],
    });
    const orphanReactions = await stack.app.request('/v1/messages/orphan_private_message/reactions', {
      headers: { authorization: `Bearer ${orphanReactionObserver.data.token}` },
    });
    expect(orphanReactions.status).toBe(404);

    const orphanThreadObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'orphan-thread-reader',
      scopes: ['threads:read'],
    });
    const orphanThread = await stack.app.request('/v1/messages/orphan_private_message/replies', {
      headers: { authorization: `Bearer ${orphanThreadObserver.data.token}` },
    });
    expect(orphanThread.status).toBe(404);

    const underScoped = await createObserverToken(stack, ws.workspaceKey, {
      name: 'channels-only',
      scopes: ['channels:read'],
    });
    const denied = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${underScoped.data.token}` },
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'insufficient_scope' },
    });
  });

  it('filters file metadata by observer channel, agent, and time filters', async () => {
    const ws = await createWorkspace(stack.app, 'observer-file-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const createTeam = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createTeam.status).toBe(201);

    const aliceGeneralFileId = await uploadCompletedFile(stack, alice.token, 'general.txt');
    const bobTeamFileId = await uploadCompletedFile(stack, bob.token, 'team.txt');
    const aliceLooseFileId = await uploadCompletedFile(stack, alice.token, 'loose.txt');

    const generalMessage = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'general file', attachments: [aliceGeneralFileId] }),
    });
    expect(generalMessage.status).toBe(201);

    const teamMessage = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ text: 'team file', attachments: [bobTeamFileId] }),
    });
    expect(teamMessage.status).toBe(201);

    const generalAliceFiles = await createObserverToken(stack, ws.workspaceKey, {
      name: 'general-alice-files',
      scopes: ['files:read'],
      filters: { channel_names: ['general'], agent_ids: [alice.agentId] },
    });
    const visibleFiles = await stack.app.request('/v1/files', {
      headers: { authorization: `Bearer ${generalAliceFiles.data.token}` },
    });
    const visibleFilesBody = await visibleFiles.json() as { data: Array<{ id: string }> };
    expect(visibleFiles.status).toBe(200);
    expect(visibleFilesBody.data.map((file) => file.id)).toEqual([aliceGeneralFileId]);

    const visibleSingle = await stack.app.request(`/v1/files/${aliceGeneralFileId}`, {
      headers: { authorization: `Bearer ${generalAliceFiles.data.token}` },
    });
    expect(visibleSingle.status).toBe(200);

    const hiddenByChannel = await stack.app.request(`/v1/files/${bobTeamFileId}`, {
      headers: { authorization: `Bearer ${generalAliceFiles.data.token}` },
    });
    expect(hiddenByChannel.status).toBe(404);

    const hiddenUnattached = await stack.app.request(`/v1/files/${aliceLooseFileId}`, {
      headers: { authorization: `Bearer ${generalAliceFiles.data.token}` },
    });
    expect(hiddenUnattached.status).toBe(404);

    const aliceFiles = await createObserverToken(stack, ws.workspaceKey, {
      name: 'alice-files',
      scopes: ['files:read'],
      filters: { agent_ids: [alice.agentId] },
    });
    const aliceFileList = await stack.app.request('/v1/files', {
      headers: { authorization: `Bearer ${aliceFiles.data.token}` },
    });
    const aliceFileListBody = await aliceFileList.json() as { data: Array<{ id: string }> };
    expect(aliceFileList.status).toBe(200);
    expect(aliceFileListBody.data.map((file) => file.id).sort()).toEqual([aliceLooseFileId, aliceGeneralFileId].sort());

    const dmScopedFiles = await createObserverToken(stack, ws.workspaceKey, {
      name: 'dm-scoped-files',
      scopes: ['files:read'],
      filters: { include_dms: true },
    });
    const dmScopedFileList = await stack.app.request('/v1/files', {
      headers: { authorization: `Bearer ${dmScopedFiles.data.token}` },
    });
    const dmScopedFileListBody = await dmScopedFileList.json() as { data: Array<{ id: string }> };
    expect(dmScopedFileList.status).toBe(200);
    expect(dmScopedFileListBody.data.map((file) => file.id)).not.toContain(aliceLooseFileId);

    const futureFiles = await createObserverToken(stack, ws.workspaceKey, {
      name: 'future-files',
      scopes: ['files:read'],
      filters: { created_after: '2999-01-01T00:00:00.000Z' },
    });
    const futureFileList = await stack.app.request('/v1/files', {
      headers: { authorization: `Bearer ${futureFiles.data.token}` },
    });
    const futureFileListBody = await futureFileList.json() as { data: unknown[] };
    expect(futureFileList.status).toBe(200);
    expect(futureFileListBody.data).toHaveLength(0);

    const futureSingle = await stack.app.request(`/v1/files/${aliceGeneralFileId}`, {
      headers: { authorization: `Bearer ${futureFiles.data.token}` },
    });
    expect(futureSingle.status).toBe(404);
  });

  it('filters node roster and node agent bindings by observer agent filters', async () => {
    const ws = await createWorkspace(stack.app, 'observer-node-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    await registerAgent(stack.app, ws.workspaceKey, 'charlie');

    for (const node of [
      { node_id: 'observer_shared_node', name: 'shared-node' },
      { node_id: 'observer_hidden_node', name: 'hidden-node' },
    ]) {
      const created = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({
          ...node,
          kind: 'ws',
          role: 'broker',
          max_agents: 4,
          capabilities: ['observe:test'],
        }),
      });
      expect(created.status).toBe(201);
    }

    for (const agentName of ['alice', 'bob']) {
      const bound = await stack.app.request('/v1/nodes/shared-node/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ agent_name: agentName }),
      });
      expect(bound.status).toBe(201);
    }
    const hiddenBound = await stack.app.request('/v1/nodes/hidden-node/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ agent_name: 'charlie' }),
    });
    expect(hiddenBound.status).toBe(201);

    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'alice-node-observer',
      scopes: ['nodes:read'],
      filters: { agent_ids: [alice.agentId] },
    });

    const nodeAgents = await stack.app.request('/v1/nodes/shared-node/agents', {
      headers: { authorization: `Bearer ${observer.data.token}` },
    });
    const nodeAgentsBody = await nodeAgents.json() as { data: Array<{ agent_id: string; agent_name: string }> };
    expect(nodeAgents.status).toBe(200);
    expect(nodeAgentsBody.data).toEqual([
      expect.objectContaining({ agent_id: alice.agentId, agent_name: 'alice' }),
    ]);
    expect(nodeAgentsBody.data.map((binding) => binding.agent_name)).not.toContain('bob');

    const roster = await stack.app.request('/v1/nodes', {
      headers: { authorization: `Bearer ${observer.data.token}` },
    });
    const rosterBody = await roster.json() as { data: Array<{ name: string; active_agents: number }> };
    expect(roster.status).toBe(200);
    expect(rosterBody.data).toEqual([
      expect.objectContaining({ name: 'shared-node', active_agents: 1 }),
    ]);

    const visibleNode = await stack.app.request('/v1/nodes/shared-node', {
      headers: { authorization: `Bearer ${observer.data.token}` },
    });
    const visibleNodeBody = await visibleNode.json() as { data: { name: string; active_agents: number } };
    expect(visibleNode.status).toBe(200);
    expect(visibleNodeBody.data).toMatchObject({ name: 'shared-node', active_agents: 1 });

    const hiddenNode = await stack.app.request('/v1/nodes/hidden-node', {
      headers: { authorization: `Bearer ${observer.data.token}` },
    });
    expect(hiddenNode.status).toBe(404);

    const bobObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'bob-node-observer',
      scopes: ['nodes:read'],
      filters: { agent_ids: [bob.agentId] },
    });
    const bobNodeAgents = await stack.app.request('/v1/nodes/shared-node/agents', {
      headers: { authorization: `Bearer ${bobObserver.data.token}` },
    });
    const bobNodeAgentsBody = await bobNodeAgents.json() as { data: Array<{ agent_id: string; agent_name: string }> };
    expect(bobNodeAgents.status).toBe(200);
    expect(bobNodeAgentsBody.data).toEqual([
      expect.objectContaining({ agent_id: bob.agentId, agent_name: 'bob' }),
    ]);
  });

  it('requires stream-scoped observer tokens for workspace WebSockets and filters events per socket', async () => {
    const ws = await createWorkspace(stack.app, 'observer-stream-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });

    const generalChannel = await stack.app.request('/v1/channels/general', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const generalChannelBody = await generalChannel.json() as { data: { id: string } };
    expect(generalChannel.status).toBe(200);

    const streamOnly = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-only',
      scopes: ['stream:read'],
      filters: { channel_names: ['general'] },
    });
    const auth = { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db };
    await expect(authenticateRealtimeWs(auth, ws.workspaceKey)).resolves.toMatchObject({
      ok: false,
      message: 'Observer token required for workspace stream',
    });
    const accepted = await authenticateRealtimeWs(auth, streamOnly.data.token!);
    expect(accepted.ok).toBe(true);

    const [streamOnlyRow] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, streamOnly.data.id));
    const streamOnlySock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, streamOnlySock, streamOnlyRow);

    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-general',
      scopes: ['stream:read', 'messages:read'],
      filters: { channel_names: ['general'] },
    });
    const [row] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, observer.data.id));
    const sock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, sock, row);

    const readObserver = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-general-id-reads',
      scopes: ['stream:read', 'messages:read'],
      filters: { channel_ids: [generalChannelBody.data.id], event_types: ['message.read'] },
    });
    const [readRow] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, readObserver.data.id));
    const readSock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, readSock, readRow);

    const generalMessage = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'stream visible' }),
    });
    const generalMessageBody = await generalMessage.json() as { data: { id: string } };
    await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'stream hidden' }),
    });
    const read = await stack.app.request(`/v1/messages/${generalMessageBody.data.id}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(read.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(streamOnlySock.ofType('message.created')).toHaveLength(0);
    expect(streamOnlySock.ofType('message.read')).toHaveLength(0);
    expect(sock.ofType('message.created')).toHaveLength(1);
    expect(sock.ofType('message.created')[0]).toMatchObject({
      channel: 'general',
      message: { text: 'stream visible' },
    });
    expect(readSock.ofType('message.read')).toHaveLength(1);
    expect(readSock.ofType('message.read')[0]).toMatchObject({
      channel_id: generalChannelBody.data.id,
      message_id: generalMessageBody.data.id,
    });
  });

  it('allows DM stream events when channel filters are present and include_dms is enabled', async () => {
    const ws = await createWorkspace(stack.app, 'observer-stream-dm-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const withoutDmScope = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-dms-without-scope',
      scopes: ['stream:read', 'messages:read', 'reactions:read', 'threads:read'],
      filters: { channel_names: ['general'], include_dms: true },
    });
    const [withoutDmScopeRow] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, withoutDmScope.data.id));
    const withoutDmScopeSock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, withoutDmScopeSock, withoutDmScopeRow);

    const threadWithoutDmScope = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-dm-threads-without-scope',
      scopes: ['stream:read', 'threads:read'],
      filters: { channel_names: ['general'], include_dms: true },
    });
    const [threadWithoutDmScopeRow] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, threadWithoutDmScope.data.id));
    const threadWithoutDmScopeSock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, threadWithoutDmScopeSock, threadWithoutDmScopeRow);

    const hiddenDm = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ to: 'bob', text: 'dm hidden without dms:read' }),
    });
    expect(hiddenDm.status).toBe(201);
    const hiddenDmBody = await hiddenDm.json() as { data: { id: string } };

    const hiddenDmReaction = await stack.app.request(`/v1/messages/${hiddenDmBody.data.id}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ emoji: 'eyes' }),
    });
    expect(hiddenDmReaction.status).toBe(201);

    const hiddenDmRead = await stack.app.request(`/v1/messages/${hiddenDmBody.data.id}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(hiddenDmRead.status).toBe(200);

    const hiddenDmReply = await stack.app.request(`/v1/messages/${hiddenDmBody.data.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ text: 'dm thread reply hidden without dms:read' }),
    });
    expect(hiddenDmReply.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(withoutDmScopeSock.ofType('dm.received')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('message.read')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('message.reacted')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('thread.reply')).toHaveLength(0);
    expect(threadWithoutDmScopeSock.ofType('thread.reply')).toHaveLength(0);

    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-dms',
      scopes: ['stream:read', 'dms:read', 'messages:read', 'reactions:read', 'threads:read'],
      filters: { channel_names: ['general'], include_dms: true },
    });

    const [row] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, observer.data.id));
    const sock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, sock, row);

    const dm = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ to: 'bob', text: 'dm visible despite channel filters' }),
    });
    expect(dm.status).toBe(201);
    const dmBody = await dm.json() as { data: { id: string } };

    const visibleDmReaction = await stack.app.request(`/v1/messages/${dmBody.data.id}/reactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ emoji: 'thumbsup' }),
    });
    expect(visibleDmReaction.status).toBe(201);

    const visibleDmRead = await stack.app.request(`/v1/messages/${dmBody.data.id}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(visibleDmRead.status).toBe(200);

    const visibleDmReply = await stack.app.request(`/v1/messages/${dmBody.data.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ text: 'dm thread reply visible with dms:read' }),
    });
    expect(visibleDmReply.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sock.ofType('dm.received')).toHaveLength(1);
    expect(sock.ofType('dm.received')[0]).toMatchObject({
      message: { text: 'dm visible despite channel filters' },
    });
    expect(sock.ofType('message.read')).toHaveLength(1);
    expect(sock.ofType('message.read')[0]).toMatchObject({
      conversation_id: expect.any(String),
      message_id: dmBody.data.id,
      agent_id: bob.agentId,
    });
    expect(sock.ofType('message.reacted')).toHaveLength(1);
    expect(sock.ofType('message.reacted')[0]).toMatchObject({
      conversation_id: expect.any(String),
      message_id: dmBody.data.id,
      emoji: 'thumbsup',
    });
    expect(sock.ofType('thread.reply')).toHaveLength(1);
    expect(sock.ofType('thread.reply')[0]).toMatchObject({
      conversation_id: expect.any(String),
      parent_id: dmBody.data.id,
      message: { text: 'dm thread reply visible with dms:read' },
    });
    expect(withoutDmScopeSock.ofType('dm.received')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('message.read')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('message.reacted')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('thread.reply')).toHaveLength(0);
    expect(threadWithoutDmScopeSock.ofType('thread.reply')).toHaveLength(0);
  });

  it('allows GET /workspace with any observer token, still allows a workspace key, and still blocks PATCH', async () => {
    const ws = await createWorkspace(stack.app, 'observer-workspace-read-ws');

    const asKey = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(asKey.status).toBe(200);
    const asKeyBody = await asKey.json() as { data: { id: string; name: string } };
    expect(asKeyBody.data.id).toBe(ws.workspaceId);

    // A narrowly-scoped observer token unrelated to workspace metadata (there
    // is no dedicated "workspace:read" scope) should still be able to read
    // this low-sensitivity endpoint — any valid observer token suffices.
    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'workspace-metadata-reader',
      scopes: ['agents:read'],
    });
    const token = observer.data.token!;

    const asObserver = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(asObserver.status).toBe(200);
    const asObserverBody = await asObserver.json() as {
      data: { id: string; name: string; plan: unknown; system_prompt: unknown; metadata: unknown };
    };
    expect(asObserverBody.data.id).toBe(ws.workspaceId);
    expect(asObserverBody.data).not.toHaveProperty('token');
    expect(asObserverBody.data).not.toHaveProperty('apiKey');

    // Writes remain workspace-key-only.
    const patchAsObserver = await stack.app.request('/v1/workspace', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'renamed-by-observer' }),
    });
    expect(patchAsObserver.status).toBe(401);

    // Agent/node tokens are still rejected for this route, matching prior
    // behavior (only the observer-token additive path was opened up):
    // allowAgent/allowNode: false means requireWorkspaceRead requires
    // `require: 'workspace'` for non-observer tokens, so an agent-kind
    // token fails token-kind validation itself (401) rather than reaching
    // the redundant in-handler 403 branch (that branch only fires when
    // allowNode/allowAgent mix true+false, widening `require` to 'any').
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice-workspace-read');
    const asAgent = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(asAgent.status).toBe(401);
  });
});
