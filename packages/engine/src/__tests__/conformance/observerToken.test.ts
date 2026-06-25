import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { observerTokens } from '../../db/schema.js';
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
  const json = await res.json() as { data: { id: string; token?: string; scopes: string[]; filters: Record<string, unknown> } };
  return { res, data: json.data };
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

  it('gates REST reads by scope and channel filters and rejects observer writes', async () => {
    const ws = await createWorkspace(stack.app, 'observer-rest-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

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

    const team = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hidden team message' }),
    });
    expect(team.status).toBe(201);

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
});
