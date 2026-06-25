import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { messageLogs, observerTokens } from '../../db/schema.js';
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
    await registerAgent(stack.app, ws.workspaceKey, 'bob');

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

  it('requires stream-scoped observer tokens for workspace WebSockets and filters events per socket', async () => {
    const ws = await createWorkspace(stack.app, 'observer-stream-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });

    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-general',
      scopes: ['stream:read'],
      filters: { channel_names: ['general'] },
    });
    const auth = { auth: stack.runtime.deps.auth, db: stack.runtime.deps.db };
    await expect(authenticateRealtimeWs(auth, ws.workspaceKey)).resolves.toMatchObject({
      ok: false,
      message: 'Observer token required for workspace stream',
    });
    const accepted = await authenticateRealtimeWs(auth, observer.data.token!);
    expect(accepted.ok).toBe(true);

    const [row] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, observer.data.id));
    const sock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, sock, row);

    await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'stream visible' }),
    });
    await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'stream hidden' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sock.ofType('message.created')).toHaveLength(1);
    expect(sock.ofType('message.created')[0]).toMatchObject({
      channel: 'general',
      message: { text: 'stream visible' },
    });
  });

  it('allows DM stream events when channel filters are present and include_dms is enabled', async () => {
    const ws = await createWorkspace(stack.app, 'observer-stream-dm-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const withoutDmScope = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-dms-without-scope',
      scopes: ['stream:read'],
      filters: { channel_names: ['general'], include_dms: true },
    });
    const [withoutDmScopeRow] = await stack.runtime.deps.db
      .select()
      .from(observerTokens)
      .where(eq(observerTokens.id, withoutDmScope.data.id));
    const withoutDmScopeSock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, withoutDmScopeSock, withoutDmScopeRow);

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

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(withoutDmScopeSock.ofType('dm.received')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('message.reacted')).toHaveLength(0);

    const observer = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-dms',
      scopes: ['stream:read', 'dms:read'],
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

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sock.ofType('dm.received')).toHaveLength(1);
    expect(sock.ofType('dm.received')[0]).toMatchObject({
      message: { text: 'dm visible despite channel filters' },
    });
    expect(sock.ofType('message.reacted')).toHaveLength(1);
    expect(sock.ofType('message.reacted')[0]).toMatchObject({
      conversation_id: expect.any(String),
      message_id: dmBody.data.id,
      emoji: 'thumbsup',
    });
    expect(withoutDmScopeSock.ofType('dm.received')).toHaveLength(0);
    expect(withoutDmScopeSock.ofType('message.reacted')).toHaveLength(0);
  });
});
