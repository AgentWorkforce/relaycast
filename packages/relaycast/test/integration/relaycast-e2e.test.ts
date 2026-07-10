import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

// Full end-to-end suite against the REAL Cloudflare worker (engine routes + all
// five Durable Objects + D1), driven over SELF.fetch — the cloud analogue of the
// upstream OSS scripts/e2e.ts + e2e-actions.ts. Proves the gateway deployment
// serves the product surface: workspaces, agents, channels, messages, threads,
// reactions, read receipts, DMs, group DMs, and agent-to-agent actions.

const ORIGIN = 'https://gateway.relaycast.dev';

type Json = Record<string, unknown> & { ok?: boolean; data?: any; error?: any };

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; idem?: string } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  const res = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text } as Json;
  }
  return { status: res.status, json };
}

// Shared state across the ordered suite.
let wsKey = '';
let aliceToken = '';
let bobToken = '';
let carolToken = '';
let aliceName = '';
let bobName = '';
let carolName = '';

async function registerAgent(name: string): Promise<string> {
  const r = await req('POST', '/v1/agents', {
    token: wsKey,
    body: { name, type: 'agent', persona: `${name} test agent`, metadata: { cli: 'vitest' } },
  });
  expect(r.status, `register ${name}: ${JSON.stringify(r.json)}`).toBe(201);
  const token = r.json.data?.token as string;
  expect(token, `register ${name} returned no token`).toBeTruthy();
  return token;
}

beforeAll(async () => {
  // Create a fresh workspace (open, unauthenticated) and three agents.
  const ws = await req('POST', '/v1/workspaces', { body: { name: `e2e-${Date.now()}` } });
  expect(ws.status, `create workspace: ${JSON.stringify(ws.json)}`).toBe(201);
  wsKey = (ws.json.data?.api_key ?? ws.json.data?.apiKey) as string;
  expect(wsKey, 'workspace returned no api_key').toBeTruthy();

  aliceName = `alice-${Date.now()}`;
  bobName = `bob-${Date.now()}`;
  carolName = `carol-${Date.now()}`;
  aliceToken = await registerAgent(aliceName);
  bobToken = await registerAgent(bobName);
  carolToken = await registerAgent(carolName);
});

describe('health + identity', () => {
  it('GET /health reports a version', async () => {
    const r = await req('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof (r.json as any).version).toBe('string');
    expect((r.json as any).version.length).toBeGreaterThan(0);
  });

  it('GET /v1/workspace returns the workspace for the workspace key', async () => {
    // /v1/workspace requires the workspace key (requireWorkspaceKey).
    const r = await req('GET', '/v1/workspace', { token: wsKey });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.data?.id).toBeTruthy();
  });

  it('GET /v1/agents lists the registered agents', async () => {
    // /v1/agents requires the workspace key (requireWorkspaceKey), not an agent token.
    const r = await req('GET', '/v1/agents', { token: wsKey });
    expect(r.status).toBe(200);
    const names = (r.json.data as any[]).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining([aliceName, bobName, carolName]));
  });

  it('rejects an unknown bearer token', async () => {
    const r = await req('GET', '/v1/workspace', { token: 'rk_live_not_a_real_token' });
    expect(r.status).toBe(401);
  });
});

describe('channels + messages', () => {
  // Unique per run so channel creation is a clean 201 regardless of persisted
  // test storage (channel names are unique within a workspace).
  const channel = `room${Date.now()}`;
  let messageId = '';

  it('creates a channel', async () => {
    const r = await req('POST', '/v1/channels', {
      token: aliceToken,
      body: { name: channel, topic: 'e2e channel' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.data?.name).toBe(channel);
  });

  it('lets a second agent join', async () => {
    const r = await req('POST', `/v1/channels/${channel}/join`, { token: bobToken, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it('posts a message to the channel', async () => {
    const r = await req('POST', `/v1/channels/${channel}/messages`, {
      token: aliceToken,
      body: { text: 'hello from alice' },
      idem: `msg-${Date.now()}`,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    messageId = r.json.data?.id as string;
    expect(messageId).toBeTruthy();
    expect(r.json.data?.text).toBe('hello from alice');
  });

  it('lists channel messages including the posted one', async () => {
    const r = await req('GET', `/v1/channels/${channel}/messages`, { token: bobToken });
    expect(r.status).toBe(200);
    const ids = (r.json.data as any[]).map((m) => m.id);
    expect(ids).toContain(messageId);
  });

  it('fetches a single message by id', async () => {
    const r = await req('GET', `/v1/messages/${messageId}`, { token: bobToken });
    expect(r.status).toBe(200);
    expect(r.json.data?.id).toBe(messageId);
  });

  it('posts and reads a thread reply', async () => {
    const reply = await req('POST', `/v1/messages/${messageId}/replies`, {
      token: bobToken,
      body: { text: 'reply from bob' },
      idem: `reply-${Date.now()}`,
    });
    expect(reply.status, JSON.stringify(reply.json)).toBe(201);

    const replies = await req('GET', `/v1/messages/${messageId}/replies`, { token: aliceToken });
    expect(replies.status).toBe(200);
    // getThread returns { parent, replies: [...] }.
    const texts = ((replies.json.data as any)?.replies ?? []).map((m: any) => m.text);
    expect(texts).toContain('reply from bob');
  });

  describe('reactions (emojis)', () => {
    it('adds a reaction', async () => {
      const r = await req('POST', `/v1/messages/${messageId}/reactions`, {
        token: bobToken,
        body: { emoji: '🚀' },
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    });

    it('lists the reaction with a count', async () => {
      const r = await req('GET', `/v1/messages/${messageId}/reactions`, { token: aliceToken });
      expect(r.status).toBe(200);
      const rocket = (r.json.data as any[]).find((x) => x.emoji === '🚀');
      expect(rocket, 'rocket reaction missing').toBeTruthy();
      expect(rocket.count).toBeGreaterThanOrEqual(1);
    });

    it('removes the reaction', async () => {
      const del = await req('DELETE', `/v1/messages/${messageId}/reactions/${encodeURIComponent('🚀')}`, {
        token: bobToken,
      });
      expect([200, 204]).toContain(del.status);

      const after = await req('GET', `/v1/messages/${messageId}/reactions`, { token: aliceToken });
      const rocket = (after.json.data as any[]).find((x) => x.emoji === '🚀');
      expect(rocket).toBeFalsy();
    });
  });

  it('marks a message read and lists readers', async () => {
    const read = await req('POST', `/v1/messages/${messageId}/read`, { token: bobToken, body: {} });
    expect(read.status).toBe(200);

    const readers = await req('GET', `/v1/messages/${messageId}/readers`, { token: aliceToken });
    expect(readers.status).toBe(200);
    const readerNames = (readers.json.data as any[]).map((x) => x.agent_name);
    expect(readerNames).toContain(bobName);
  });
});

describe('direct messages', () => {
  it('sends a 1:1 DM and the recipient sees the conversation', async () => {
    const dm = await req('POST', '/v1/dm', {
      token: aliceToken,
      body: { to: bobName, text: 'hey bob, dm here' },
      idem: `dm-${Date.now()}`,
    });
    expect(dm.status, JSON.stringify(dm.json)).toBe(201);
    const conversationId = dm.json.data?.conversation_id as string;
    expect(conversationId).toBeTruthy();

    const convos = await req('GET', '/v1/dm/conversations', { token: bobToken });
    expect(convos.status).toBe(200);
    const ids = (convos.json.data as any[]).map((c) => c.id);
    expect(ids).toContain(conversationId);

    const msgs = await req('GET', `/v1/dm/${conversationId}/messages`, { token: bobToken });
    expect(msgs.status).toBe(200);
    const texts = (msgs.json.data as any[]).map((m) => m.text);
    expect(texts).toContain('hey bob, dm here');
  });

  it('creates a group DM and sends a message into it', async () => {
    const group = await req('POST', '/v1/dm/group', {
      token: aliceToken,
      body: { participants: [bobName, carolName], name: 'e2e-group' },
      idem: `gdm-${Date.now()}`,
    });
    expect(group.status, JSON.stringify(group.json)).toBe(201);
    const conversationId = (group.json.data?.id ?? group.json.data?.conversation_id) as string;
    expect(conversationId).toBeTruthy();

    const send = await req('POST', `/v1/dm/${conversationId}/messages`, {
      token: carolToken,
      body: { text: 'group hello' },
      idem: `gdm-msg-${Date.now()}`,
    });
    expect(send.status, JSON.stringify(send.json)).toBe(201);
  });
});

describe('actions (agent-to-agent RPC)', () => {
  const action = 'deploy';
  let invocationId = '';

  it('handler registers an action', async () => {
    const r = await req('POST', '/v1/actions', {
      token: aliceToken,
      body: {
        name: action,
        description: 'Deploy a service to an environment',
        handler_agent: aliceName,
        input_schema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
        output_schema: { type: 'object', properties: { url: { type: 'string' } } },
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.data?.name).toBe(action);
  });

  it('enforces handler ownership on registration', async () => {
    const r = await req('POST', '/v1/actions', {
      token: bobToken,
      body: { name: 'sneaky', description: 'x', handler_agent: aliceName },
    });
    expect(r.status).toBe(403);
  });

  it('lists and gets the registered action', async () => {
    const list = await req('GET', '/v1/actions', { token: bobToken });
    expect(list.status).toBe(200);
    expect((list.json.data as any[]).map((a) => a.name)).toContain(action);

    const get = await req('GET', `/v1/actions/${action}`, { token: bobToken });
    expect(get.status).toBe(200);
    expect(get.json.data?.handler_agent ?? get.json.data?.handler_agent_id).toBeTruthy();
  });

  it('caller invokes the action', async () => {
    const r = await req('POST', `/v1/actions/${action}/invoke`, {
      token: bobToken,
      body: { input: { env: 'staging' } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    invocationId = r.json.data?.invocation_id as string;
    expect(invocationId).toBeTruthy();
    // @relaycast/engine 5.x reworked the action-invocation state machine again:
    // a freshly invoked agent-handler invocation now lands in `pending`
    // (open-invocation statuses are pending | dispatched | invoked), where 4.0
    // reported `dispatched` and 3.x reported `invoked` on creation. It
    // transitions to `dispatched` once the handler node drains; the handler
    // still completes it below.
    expect(r.json.data?.status).toBe('pending');
  });

  it('handler completes the invocation', async () => {
    const r = await req('POST', `/v1/actions/${action}/invocations/${invocationId}/complete`, {
      token: aliceToken,
      body: { output: { url: 'https://staging.example.com' }, duration_ms: 1200 },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data?.status).toBe('completed');
  });

  it('reflects the completed invocation with its output', async () => {
    const r = await req('GET', `/v1/actions/${action}/invocations/${invocationId}`, { token: bobToken });
    expect(r.status).toBe(200);
    expect(r.json.data?.status).toBe('completed');
    expect(r.json.data?.output?.url).toBe('https://staging.example.com');
  });

  it('deletes the action', async () => {
    const del = await req('DELETE', `/v1/actions/${action}`, { token: aliceToken });
    expect([200, 204]).toContain(del.status);
    const after = await req('GET', `/v1/actions/${action}`, { token: bobToken });
    expect(after.status).toBe(404);
  });
});
