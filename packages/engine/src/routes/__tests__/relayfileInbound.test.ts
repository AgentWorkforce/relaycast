import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime } from '../../adapters/node/index.js';
import { createWorkspace, registerAgent } from '../../__tests__/conformance/harness.js';
import { deliveries } from '../../db/schema.js';
import {
  deriveRelayfileInboundSecret,
  formatRelayfileEventMessage,
} from '../relayfileInbound.js';

interface Stack {
  app: ReturnType<typeof createEngine>;
  runtime: NodeRuntime;
}

const stacks: Stack[] = [];

function makeStack(): Stack {
  const runtime = createNodeRuntime({
    dbPath: ':memory:',
    baseUrl: 'http://localhost:0',
    migrate: true,
    config: {
      environment: 'test',
      relayfileInboundSecret: 'relaycast-master',
    },
    presence: { sweepIntervalMs: 0 },
    eventQueue: { pollIntervalMs: 0 },
  });
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

describe('relayfile inbound bridge', () => {
  it('provisions a signed relayfile target for a workspace channel', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-target');

    const res = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', pathGlob: '/slack/channels/C123/messages/**' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { data: { url: string; secret: string; channel_id: string } };
    expect(body.data.url).toContain('/v1/integrations/relayfile/inbound/');
    expect(body.data.url).toContain('provider=slack');
    expect(body.data.url).toContain('pathGlob=%2Fslack%2Fchannels%2FC123%2Fmessages%2F**');
    expect(body.data.secret).toBe(await deriveRelayfileInboundSecret('relaycast-master', {
      workspaceId: ws.workspaceId,
      channelId: body.data.channel_id,
      provider: 'slack',
      pathGlob: '/slack/channels/C123/messages/**',
    }));
  });

  it('accepts a signed relayfile event, injects one message, and dedupes replay', async () => {
    const stack = makeStack();
    const ws = await createWorkspace(stack.app, 'relayfile-delivery');
    const targetRes = await stack.app.request('/v1/integrations/relayfile/inbound-target', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', provider: 'slack', pathGlob: '/slack/channels/C123/messages/**' }),
    });
    const targetBody = await targetRes.json() as { data: { url: string; secret: string } };
    const target = targetBody.data;
    const event = {
      eventId: 'evt_slack_1',
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
    const replay = await stack.app.request(target.url, {
      method: 'POST',
      headers: signedHeaders(target.secret, payload, timestamp),
      body: payload,
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ data: { replayed: true } });

    const list = await stack.app.request('/v1/channels/general/messages', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(list.status).toBe(200);
    const messages = await list.json() as { data: Array<{ text: string }> };
    expect(messages.data.filter((message) => message.text.includes('hello from slack'))).toHaveLength(1);
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
      body: JSON.stringify({ channel: 'general', provider: 'slack', pathGlob: '/slack/channels/C123/messages/**' }),
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
      body: JSON.stringify({ channel: 'general', provider: 'linear', pathGlob: '/linear/issues/**' }),
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
});
