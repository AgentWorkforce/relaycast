import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime } from '../../adapters/node/index.js';
import { createWorkspace, registerAgent } from '../../__tests__/conformance/harness.js';
import { deliveries } from '../../db/schema.js';
import type { KeyValueStore } from '../../ports/kv.js';
import {
  deriveRelayfileInboundSecret,
  formatRelayfileEventMessage,
  verifyRelayfileSignature,
} from '../relayfileInbound.js';

interface Stack {
  app: ReturnType<typeof createEngine>;
  runtime: NodeRuntime;
}

const stacks: Stack[] = [];

function makeStack(opts: { kv?: KeyValueStore; depthCap?: number } = {}): Stack {
  const runtime = createNodeRuntime({
    dbPath: ':memory:',
    baseUrl: 'http://localhost:0',
    migrate: true,
    config: {
      environment: 'test',
      ...(opts.depthCap ? { mailbox: { depthCap: opts.depthCap } } : {}),
      relayfileInboundSecret: 'relaycast-master',
    },
    presence: { sweepIntervalMs: 0 },
    eventQueue: { pollIntervalMs: 0 },
  });
  if (opts.kv) runtime.deps.kv = opts.kv;
  runtime.webhookQueue.stop();
  const stack = { app: createEngine(runtime.deps), runtime };
  stacks.push(stack);
  return stack;
}

afterEach(() => {
  for (const stack of stacks.splice(0)) stack.runtime.close();
});

function signedHeaders(secret: string, body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'content-type': 'application/json',
    'X-Relay-Timestamp': timestamp,
    'X-Relay-Signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    'X-Relay-Event-Id': 'evt_1',
  };
}

class FailingKeyValueStore implements KeyValueStore {
  async get(): Promise<string | null> {
    throw new Error('kv unavailable');
  }

  async put(): Promise<void> {
    throw new Error('kv unavailable');
  }

  async delete(): Promise<void> {
    throw new Error('kv unavailable');
  }

  async increment(): Promise<number> {
    throw new Error('kv unavailable');
  }
}

describe('relayfile inbound bridge', () => {
  it('returns retryable overflow and accepts the same unique event after capacity recovers', async () => {
    const stack = makeStack({ depthCap: 1 });
    const ws = await createWorkspace(stack.app, 'inbound-backpressure');
    const busy = await registerAgent(stack.app, ws.workspaceKey, 'busy');
    const post = (path: string, token: string, body?: unknown) => stack.app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await post('/v1/channels/general/join', busy.token);
    const targetRes = await post('/v1/integrations/relayfile/inbound-target', ws.workspaceKey,
      { channel: 'general', provider: 'github', path_glob: '/github/repos/o/r/issues/**' });
    expect(targetRes.status).toBe(201);
    const { data: target } = await targetRes.json();
    const emit = (id: string) => {
      const path = '/github/repos/o/r/issues/12.json';
      const body = JSON.stringify({ eventId: id, type: 'file.updated', path, provider: 'github', revision: id,
        snapshot: { path, contentType: 'application/json', encoding: 'utf-8', content: JSON.stringify({ title: id, body: id, number: 12 }) } });
      return stack.app.request(target.url, { method: 'POST', body,
        headers: { ...signedHeaders(target.secret, body), 'X-Relay-Event-Id': id } });
    };
    expect((await emit('first')).status).toBe(201);
    const rejected = await emit('second');
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('Retry-After')).toBe('30');
    expect(await rejected.json()).toMatchObject({ error: { code: 'mailbox_full' } });
    const inbox = await stack.app.request('/v1/deliveries', { headers: { authorization: `Bearer ${busy.token}` } });
    const { data: queued } = await inbox.json();
    expect(queued).toHaveLength(1);
    await post(`/v1/deliveries/${queued[0].id}/ack`, busy.token);
    const retried = await emit('second');
    expect(retried.status).toBe(201);
    const { data: accepted } = await retried.json();
    const duplicate = await emit('second');
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ data: { replayed: true, message_id: accepted.message_id } });
    const stored = await stack.app.request('/v1/channels/general/messages', { headers: { authorization: `Bearer ${ws.workspaceKey}` } });
    expect((await stored.json()).data).toHaveLength(2);
  });

  it('provisions a signed relayfile target for a workspace channel', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-target');

    const res = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', path_glob: '/slack/channels/C123/messages/**' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; data: { url: string; secret: string; channel_id: string } };
    expect(body.ok).toBe(true);
    expect(body.data.url).toContain('/v1/integrations/relayfile/inbound/');
    expect(body.data.url).toContain('provider=slack');
    expect(body.data.url).toContain('path_glob=%2Fslack%2Fchannels%2FC123%2Fmessages%2F**');
    expect(body.data.secret).toBe(await deriveRelayfileInboundSecret('relaycast-master', {
      workspaceId: ws.workspaceId,
      channelId: body.data.channel_id,
      provider: 'slack',
      pathGlob: '/slack/channels/C123/messages/**',
    }));
  });

  it('rejects whitespace-only relayfile target path globs', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-target-blank-glob');

    const res = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', path_glob: '   ' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('rejects inbound delivery URLs without an explicit path glob', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-missing-glob');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', path_glob: '/slack/channels/C123/messages/**' }),
    });
    const target = (await targetRes.json() as { data: { url: string } }).data;
    const url = new URL(target.url);
    url.searchParams.delete('path_glob');

    const res = await stack.app.request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('rejects inbound delivery URLs with blank path globs', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-blank-query-glob');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', path_glob: '/slack/channels/C123/messages/**' }),
    });
    const target = (await targetRes.json() as { data: { url: string } }).data;
    const url = new URL(target.url);
    url.searchParams.set('path_glob', '   ');

    const res = await stack.app.request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('accepts a signed relayfile event, injects one message, and dedupes replay', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-delivery');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', path_glob: '/slack/channels/C123/messages/**' }),
    });
    const targetBody = await targetRes.json() as { data: { url: string; secret: string } };
    const target = targetBody.data;
    const event = {
      eventId: 'evt_slack_1',
      providerEventType: 'message.created',
      resourceRef: '/slack/channels/C123',
      type: 'file.created',
      path: '/slack/channels/C123/messages/1780607825_485189/meta.json',
      revision: 'rev_1',
      origin: 'provider_sync',
      provider: 'slack',
      timestamp: new Date().toISOString(),
      snapshot: {
        path: '/slack/channels/C123/messages/1780607825_485189/meta.json',
        contentType: 'application/json',
        encoding: 'utf-8',
        content: JSON.stringify({ user_name: 'Ada', text: 'hello from slack' }),
      },
    };
    const payload = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const first = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders(target.secret, payload, timestamp),
      body: payload,
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ ok: true, data: { replayed: false } });
    const replay = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders(target.secret, payload, timestamp),
      body: payload,
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ ok: true, data: { replayed: true } });

    const list = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(list.status).toBe(200);
    const messages = await list.json() as { data: Array<{ text: string }> };
    expect(messages.data.filter((message) => message.text.includes('hello from slack'))).toHaveLength(1);
    expect(messages.data[0]).toMatchObject({ metadata: { provider_event_type: 'message.created', resource_ref: '/slack/channels/C123' } });
  });

  it('creates channel deliveries so node/broker agents receive the message', async () => {
    // Regression guard for the node-delivery bug: triggerIntegrationMessage used
    // to insert the message with a bare write (no delivery rows), so fanoutToChannel
    // (which skips node context for message.created) meant node-connected agents
    // never received inbound integration messages. A queued delivery row for a
    // channel member is the proof that routeDeliveryOutcomes has something to dispatch.
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-node-delivery');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob'); // auto-joins #general

    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', path_glob: '/slack/channels/C123/messages/**' }),
    });
    const target = (await targetRes.json() as { data: { url: string; secret: string } }).data;

    const event = {
      eventId: 'evt_node_1',
      type: 'file.created',
      path: '/slack/channels/C123/messages/1780607825_999/meta.json',
      revision: 'rev_1',
      origin: 'provider_sync',
      provider: 'slack',
      timestamp: new Date().toISOString(),
      snapshot: {
        path: '/slack/channels/C123/messages/1780607825_999/meta.json',
        contentType: 'application/json',
        encoding: 'utf-8',
        content: JSON.stringify({ user_name: 'Ada', text: 'ping the agents' }),
      },
    };
    const payload = JSON.stringify(event);
    const res = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders(target.secret, payload),
      body: payload,
    });
    expect(res.status).toBe(201);
    const messageId = (await res.json() as { data: { message_id: string } }).data.message_id;

    const rows = await stack.runtime.deps.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.agentId, bob.agentId), eq(deliveries.messageId, messageId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
  });

  it('rejects bad signatures', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-bad-signature');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'linear', path_glob: '/linear/issues/**' }),
    });
    const targetBody = await targetRes.json() as { data: { url: string } };
    const target = targetBody.data;
    const payload = JSON.stringify({ eventId: 'evt_bad', type: 'file.created', path: '/linear/issues/ENG-1.json', provider: 'linear' });
    const res = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders('wrong-secret', payload),
      body: payload,
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBeTruthy();
  });

  it('rejects oversized relayfile event bodies before signature verification', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-large-body');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'linear', path_glob: '/linear/issues/**' }),
    });
    const target = (await targetRes.json() as { data: { url: string } }).data;
    const payload = 'x'.repeat(1024 * 1024 + 1);

    const res = await stack.app.request(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      body: payload,
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'payload_too_large' },
    });
  });

  it('rejects malformed signed event fields as bad requests', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-malformed-event');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'linear', path_glob: '/linear/issues/**' }),
    });
    const target = (await targetRes.json() as { data: { url: string; secret: string } }).data;
    const payload = JSON.stringify({
      eventId: 'evt_bad_type',
      type: 'file.created',
      path: { not: 'a string' },
      provider: 'linear',
      snapshot: { content: 42 },
    });

    const res = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders(target.secret, payload),
      body: payload,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
  });

  it('fails closed when idempotency storage is unavailable', async () => {
    const stack = makeStack({ kv: new FailingKeyValueStore() });
    const ws = await createWorkspace(stack.app, 'relayfile-kv-failure');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'linear', path_glob: '/linear/issues/**' }),
    });
    const target = (await targetRes.json() as { data: { url: string; secret: string } }).data;
    const payload = JSON.stringify({
      eventId: 'evt_kv_failure',
      type: 'file.created',
      path: '/linear/issues/ENG-1.json',
      provider: 'linear',
      snapshot: { content: JSON.stringify({ title: 'Do not duplicate' }) },
    });

    const res = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders(target.secret, payload),
      body: payload,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: { code: 'idempotency_unavailable' },
    });
  });

  it('verifies signatures against the exact request bytes', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = 'binary-secret';
    const body = new Uint8Array([0xff, 0x00, 0x61]).buffer;
    const signature = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]))
      .digest('hex');

    await expect(verifyRelayfileSignature(
      new Headers({ 'X-Relay-Timestamp': timestamp, 'X-Relay-Signature': signature }),
      body,
      secret,
      Number.parseInt(timestamp, 10) * 1000,
    )).resolves.toEqual({ ok: true });
  });

  it('formats provider records with a path fallback', () => {
    expect(formatRelayfileEventMessage({
      type: 'file.created',
      path: '/github/repos/o/r/issues/1.json',
      snapshot: { content: JSON.stringify({ title: 'Bug', body: 'Needs fixing', user: { login: 'octo' } }) },
    }, 'github')).toMatchObject({
      author: 'octo',
      text: expect.stringContaining('Bug'),
    });
  });

  it('keeps long provider body fields under the body cap', () => {
    const longBody = 'x'.repeat(1400);

    const message = formatRelayfileEventMessage({
      type: 'file.created',
      path: '/github/repos/o/r/issues/1.json',
      snapshot: { content: JSON.stringify({ body: longBody }) },
    }, 'github');

    expect(message?.text).toContain(`${'x'.repeat(1200)}...`);
    expect(message?.text).not.toContain(longBody);
  });
  it('exposes terminal provider state from a Cloud sync envelope without treating metadata as authority', () => {
    const payload = { number: 42, state: 'closed', merged: true, title: 'Fix', user: { login: 'author' } };
    const snapshot = { content: JSON.stringify({ provider: 'github', objectType: 'pull_request', objectId: '42', deleted: false, connectionId: 'connection', payload }) };
    const message = formatRelayfileEventMessage({ type: 'file.updated', providerEventType: 'pull_request.closed', path: '/github/repos/a/b/pulls/42__fix/meta.json', snapshot }, 'github');
    expect(message).toMatchObject({ author: 'author', record: payload, text: expect.stringContaining('Fix') });
    expect(formatRelayfileEventMessage({ type: 'file.updated', path: '/github/42.json', snapshot }, 'github')?.text).toContain('Github update');
    expect(formatRelayfileEventMessage({ type: 'file.updated', path: '/github/42.json', snapshot: { content: JSON.stringify({ title: 'Ordinary record', payload }) } }, 'github')?.record).toMatchObject({ title: 'Ordinary record', payload });
  });

});
