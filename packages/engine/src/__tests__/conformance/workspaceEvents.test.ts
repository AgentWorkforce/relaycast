import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { workspaceEvents } from '../../db/schema.js';

interface EventLogResponse {
  ok: boolean;
  data?: {
    events: Array<{
      seq: number;
      type: string;
      channel_id: string | null;
      payload: Record<string, unknown>;
      created_at: string;
    }>;
    latest_seq: number;
    next_since: number;
  };
  error?: { code: string; message: string };
}

async function createObserverToken(
  stack: TestStack,
  workspaceKey: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await stack.app.request('/v1/observer-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const json = await res.json() as { data: { token: string } };
  return json.data.token;
}

async function getEvents(stack: TestStack, token: string, query = ''): Promise<{ status: number; body: EventLogResponse }> {
  const res = await stack.app.request(`/v1/workspace/events${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() as EventLogResponse };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('workspace event log', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('appends a log row for channel messages and stamps the assigned seq on the published frame', async () => {
    const ws = await createWorkspace(stack.app, 'event-log-append-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

    const generalRes = await stack.app.request('/v1/channels/general', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const general = (await generalRes.json() as { data: { id: string } }).data;

    const sock = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, sock);

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hello log' }),
    });
    expect(post.status).toBe(201);
    await settle();

    const rows = await stack.runtime.deps.db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, ws.workspaceId));
    const messageRows = rows.filter((row) => row.type === 'message.created');
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0].channelId).toBe(general.id);
    // Stored payload is the published frame without seq (seq lives in the column).
    const stored = JSON.parse(messageRows[0].payload) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('seq');
    expect(stored).toMatchObject({ type: 'message.created', message: { text: 'hello log' } });

    const frames = sock.ofType('message.created');
    expect(frames).toHaveLength(1);
    expect(frames[0].seq).toBe(messageRows[0].seq);
    expect(frames[0]).toMatchObject({ channel: 'general', message: { text: 'hello log' } });

    // The REST log returns the same row, cursorable by seq.
    const list = await getEvents(stack, ws.workspaceKey);
    expect(list.status).toBe(200);
    const logged = list.body.data!.events.find((event) => event.type === 'message.created');
    expect(logged).toMatchObject({
      seq: messageRows[0].seq,
      channel_id: general.id,
      payload: { type: 'message.created' },
    });
  });

  it('serves cursor-based reads to workspace keys with ascending seq and latest_seq', async () => {
    const ws = await createWorkspace(stack.app, 'event-log-cursor-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    for (const text of ['one', 'two', 'three']) {
      await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text }),
      });
    }
    await settle();

    const all = await getEvents(stack, ws.workspaceKey);
    expect(all.status).toBe(200);
    const events = all.body.data!.events;
    expect(events.length).toBeGreaterThanOrEqual(3);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(1);
    expect(all.body.data!.latest_seq).toBe(seqs[seqs.length - 1]);

    // since is exclusive; caught-up readers get an empty page with latest_seq intact.
    const latest = all.body.data!.latest_seq;
    const rest = await getEvents(stack, ws.workspaceKey, `?since=${latest - 1}`);
    expect(rest.body.data!.events.map((event) => event.seq)).toEqual([latest]);
    const caughtUp = await getEvents(stack, ws.workspaceKey, `?since=${latest}`);
    expect(caughtUp.body.data!.events).toEqual([]);
    expect(caughtUp.body.data!.latest_seq).toBe(latest);

    // limit is applied after the cursor.
    const limited = await getEvents(stack, ws.workspaceKey, '?since=0&limit=2');
    expect(limited.body.data!.events.map((event) => event.seq)).toEqual([1, 2]);

    // Query validation: limit outside 1..500 and negative since are rejected.
    expect((await getEvents(stack, ws.workspaceKey, '?limit=0')).status).toBe(400);
    expect((await getEvents(stack, ws.workspaceKey, '?limit=501')).status).toBe(400);
    expect((await getEvents(stack, ws.workspaceKey, '?since=-1')).status).toBe(400);
  });

  it('enforces the auth matrix: workspace key ok, stream:read observer ok, others rejected', async () => {
    const ws = await createWorkspace(stack.app, 'event-log-auth-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');

    expect((await getEvents(stack, ws.workspaceKey)).status).toBe(200);

    const streamToken = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream',
      scopes: ['stream:read'],
    });
    expect((await getEvents(stack, streamToken)).status).toBe(200);

    const noStreamToken = await createObserverToken(stack, ws.workspaceKey, {
      name: 'no-stream',
      scopes: ['messages:read'],
    });
    const insufficient = await getEvents(stack, noStreamToken);
    expect(insufficient.status).toBe(403);
    expect(insufficient.body.error?.code).toBe('insufficient_scope');

    // Agent tokens are rejected outright (the read requires a workspace key or
    // observer token — same treatment as GET /activity).
    const agentDenied = await getEvents(stack, alice.token);
    expect(agentDenied.status).toBe(401);
  });

  it('filters channel-bound rows for scoped observer tokens while rows without a channel pass', async () => {
    const ws = await createWorkspace(stack.app, 'event-log-scope-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    const generalRes = await stack.app.request('/v1/channels/general', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    const general = (await generalRes.json() as { data: { id: string } }).data;

    await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'visible' }),
    });
    await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hidden' }),
    });
    await settle();

    const full = await getEvents(stack, ws.workspaceKey);
    const allEvents = full.body.data!.events;
    expect(allEvents.filter((event) => event.type === 'message.created')).toHaveLength(2);
    const channellessSeqs = allEvents.filter((event) => event.channel_id === null).map((event) => event.seq);
    expect(channellessSeqs.length).toBeGreaterThan(0); // workspace-wide rows (channel.created for team-chat)

    // Backfill applies the live stream's per-event-type scopes
    // (observerAllowsEvent): a stream:read-only token can open the route but
    // sees no message rows — parity with the live socket.
    const streamOnlyToken = await createObserverToken(stack, ws.workspaceKey, {
      name: 'stream-only',
      scopes: ['stream:read'],
    });
    const streamOnly = await getEvents(stack, streamOnlyToken);
    expect(streamOnly.status).toBe(200);
    expect(streamOnly.body.data!.events.filter((event) => event.type === 'message.created')).toHaveLength(0);

    const scopedToken = await createObserverToken(stack, ws.workspaceKey, {
      name: 'general-only',
      scopes: ['stream:read', 'messages:read', 'agents:read', 'activity:read'],
      filters: { channel_names: ['general'] },
    });
    const scoped = await getEvents(stack, scopedToken);
    expect(scoped.status).toBe(200);
    const scopedEvents = scoped.body.data!.events;
    const scopedMessages = scopedEvents.filter((event) => event.type === 'message.created');
    expect(scopedMessages).toHaveLength(1);
    expect(scopedMessages[0].channel_id).toBe(general.id);
    // Live parity: the channel.created row for team-chat has no channel_id
    // COLUMN, but its payload carries the channel name — observerAllowsEvent
    // hides it from a general-scoped token exactly like the live stream does
    // (both by the channels:read scope and by the channel_names filter).
    expect(scopedEvents.filter((event) => event.type === 'channel.created')).toHaveLength(0);
    // latest_seq reflects the workspace log, not the filtered view.
    expect(scoped.body.data!.latest_seq).toBe(full.body.data!.latest_seq);

    // channel_ids filters work the same way.
    const idScopedToken = await createObserverToken(stack, ws.workspaceKey, {
      name: 'general-by-id',
      scopes: ['stream:read', 'messages:read', 'agents:read', 'activity:read'],
      filters: { channel_ids: [general.id] },
    });
    const idScoped = await getEvents(stack, idScopedToken);
    const idScopedMessages = idScoped.body.data!.events.filter((event) => event.type === 'message.created');
    expect(idScopedMessages).toHaveLength(1);
    expect(idScopedMessages[0].channel_id).toBe(general.id);
  });

  it('pages past fully-filtered windows for scoped tokens via next_since', async () => {
    const ws = await createWorkspace(stack.app, 'event-log-paging-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'hidden-room' }),
    });

    // Three hidden messages first, then one visible message.
    for (const text of ['h1', 'h2', 'h3']) {
      await stack.app.request('/v1/channels/hidden-room/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text }),
      });
    }
    await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'visible' }),
    });
    await settle();

    const scopedToken = await createObserverToken(stack, ws.workspaceKey, {
      name: 'general-only-paging',
      scopes: ['stream:read', 'messages:read'],
      filters: { channel_names: ['general'] },
    });

    // limit=1 with three hidden rows in front: the server scans past the
    // filtered window and still returns the visible row.
    const page = await getEvents(stack, scopedToken, '?limit=1');
    expect(page.status).toBe(200);
    const messages = page.body.data!.events.filter((event) => event.type === 'message.created');
    expect(messages).toHaveLength(1);
    expect((messages[0].payload as { message?: { text?: string } }).message?.text).toBe('visible');
    // next_since consumed at least through the visible row, so the next page
    // makes progress instead of re-reading the hidden window.
    expect(page.body.data!.next_since).toBeGreaterThanOrEqual(messages[0].seq);

    // A cursor past the last visible row returns an empty page whose
    // next_since still advances to the end of the log (no stall).
    const tailPage = await getEvents(stack, scopedToken, `?since=${page.body.data!.next_since}`);
    expect(tailPage.status).toBe(200);
    const tailMessages = tailPage.body.data!.events.filter((event) => event.type === 'message.created');
    expect(tailMessages).toHaveLength(0);
    expect(tailPage.body.data!.next_since).toBeGreaterThanOrEqual(page.body.data!.next_since);
  });
});
