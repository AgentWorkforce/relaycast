import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Fake auth context injected by mocked auth middleware.
const fakeWorkspace = {
  id: 'ws_test123',
  name: 'test',
  apiKeyHash: 'hash_test',
  plan: 'free',
  systemPrompt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  createdAt: new Date(),
  metadata: {},
};

const fakeAgent = {
  id: 'agent_test1',
  workspaceId: 'ws_test123',
  name: 'TestBot',
  type: 'agent',
  tokenHash: 'hash_test',
  status: 'online',
  persona: null,
  metadata: {},
  createdAt: new Date(),
  lastSeen: new Date(),
};

vi.mock('../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('../engine/channel.js', () => ({
  createChannel: vi.fn(),
  listChannels: vi.fn(),
  getChannel: vi.fn(),
  updateChannel: vi.fn(),
  archiveChannel: vi.fn(),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  getMembers: vi.fn(),
  inviteAgent: vi.fn(),
}));

vi.mock('../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock('../engine/thread.js', () => ({
  postReply: vi.fn(),
  getThread: vi.fn(),
}));

vi.mock('../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getDmMessages: vi.fn(),
}));

vi.mock('../engine/groupDm.js', () => ({
  createGroupDm: vi.fn(),
  postGroupMessage: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock('../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
}));

vi.mock('../engine/search.js', () => ({
  searchMessages: vi.fn(),
}));

vi.mock('../engine/inbox.js', () => ({
  getInbox: vi.fn(),
}));

vi.mock('../engine/receipt.js', () => ({
  markRead: vi.fn(),
  getReaders: vi.fn(),
  getReadStatus: vi.fn(),
}));

vi.mock('../engine/file.js', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
}));

vi.mock('../engine/billing.js', () => ({
  subscribe: vi.fn(),
  getSubscription: vi.fn(),
  getUsage: vi.fn(),
  getInvoices: vi.fn(),
  createPortalSession: vi.fn(),
  handleWebhook: vi.fn(),
}));

vi.mock('../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
}));

vi.mock('../engine/presence.js', () => ({
  getPresence: vi.fn(),
}));

vi.mock('../engine/usage.js', () => ({
  incrementUsage: vi.fn(),
  getUsageCounters: vi.fn(),
}));

vi.mock('../engine/webhooks.js', () => ({
  processWebhook: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => {
    _req.workspace = fakeWorkspace;
    _req.agent = fakeAgent;
    next();
  },
  requireWorkspaceKey: (_req: any, _res: any, next: any) => {
    _req.workspace = fakeWorkspace;
    next();
  },
  requireAgentToken: (_req: any, _res: any, next: any) => {
    _req.workspace = fakeWorkspace;
    _req.agent = fakeAgent;
    next();
  },
  hashToken: vi.fn((t: string) => 'hash_' + t),
}));

vi.mock('../middleware/rateLimit.js', () => ({
  rateLimit: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/planLimits.js', () => ({
  checkPlanLimit: () => (_req: any, _res: any, next: any) => next(),
  PLAN_LIMITS: {},
}));

vi.mock('../middleware/usageTracker.js', () => ({
  usageTracker: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/presenceRefresh.js', () => ({
  presenceRefresh: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../ws/pubsub.js', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../engine/eventDelivery.js', () => ({
  deliverEvent: vi.fn(),
}));

vi.mock('../engine/eventQueue.js', () => ({
  enqueueEvent: vi.fn().mockResolvedValue('evt_mock'),
}));

import { app } from '../app.js';

import { createWorkspace } from '../engine/workspace.js';
import { createChannel, getChannel } from '../engine/channel.js';
import { postMessage, getMessages } from '../engine/message.js';
import { searchMessages } from '../engine/search.js';
import { getAgentByName } from '../engine/agent.js';

// Don't mock snowflake - test it directly
import { SnowflakeGenerator } from '../engine/snowflake.js';

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(createWorkspace).mockReset().mockResolvedValue({ id: 'ws_new', name: 'new' } as any);

  vi.mocked(getChannel).mockReset().mockResolvedValue({ id: 'ch_1', name: 'general' } as any);
  vi.mocked(createChannel).mockReset().mockResolvedValue({ id: 'ch_1', name: 'general' } as any);

  vi.mocked(postMessage).mockReset().mockResolvedValue({ id: 'msg_1' } as any);
  vi.mocked(getMessages).mockReset().mockResolvedValue([] as any);

  vi.mocked(searchMessages).mockReset().mockResolvedValue([] as any);
  vi.mocked(getAgentByName).mockReset().mockResolvedValue({ ...fakeAgent } as any);
});

describe('Unicode Handling', () => {
  it('posts message with emoji text and preserves Unicode', async () => {
    const text = '🎉🚀💻';
    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, data: { id: 'msg_1' } });

    expect(vi.mocked(getChannel)).toHaveBeenCalledWith(fakeWorkspace.id, 'general');
    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ text }),
    );
  });

  it('posts message with CJK characters and preserves Unicode', async () => {
    const text = '日本語テスト';
    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ id: 'msg_1' });

    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ text }),
    );
  });

  it('creates channel with Unicode characters in name', async () => {
    const name = 'dev_日本語-🎉';
    const res = await request(app)
      .post('/v1/channels')
      .send({ name, topic: 'unicode topic' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, data: { id: 'ch_1', name: 'general' } });

    expect(vi.mocked(createChannel)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      { name, topic: 'unicode topic' },
      fakeAgent.id,
    );
  });

  it('posts message with mixed Unicode and ASCII', async () => {
    const text = 'hello 日本語 🎉 123';
    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ id: 'msg_1' });

    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ text }),
    );
  });

  it('searches with Unicode query and preserves it', async () => {
    const q = '日本語テスト🎉';
    const res = await request(app)
      .get('/v1/search')
      .query({ q });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });

    expect(vi.mocked(searchMessages)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      expect.objectContaining({ q }),
    );
  });
});

describe('Boundary Testing', () => {
  it('supports pagination with limit=0', async () => {
    const res = await request(app)
      .get('/v1/channels/general/messages')
      .query({ limit: '0' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });

    expect(vi.mocked(getMessages)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      expect.objectContaining({ limit: 0, before: undefined, after: undefined }),
    );
  });

  it('supports pagination with limit=100', async () => {
    const res = await request(app)
      .get('/v1/channels/general/messages')
      .query({ limit: '100' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });

    expect(vi.mocked(getMessages)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('supports pagination with before cursor at a boundary value', async () => {
    const before = '0';
    const res = await request(app)
      .get('/v1/channels/general/messages')
      .query({ before, limit: '1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });

    expect(vi.mocked(getMessages)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      expect.objectContaining({ before, limit: 1 }),
    );
  });

  it('returns empty array for empty channel messages', async () => {
    vi.mocked(getMessages).mockResolvedValueOnce([] as any);

    const res = await request(app)
      .get('/v1/channels/general/messages');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });

  it('returns empty array for empty search results', async () => {
    vi.mocked(searchMessages).mockResolvedValueOnce([] as any);

    const res = await request(app)
      .get('/v1/search')
      .query({ q: 'nothing-here' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: [] });
  });
});

describe('Error Handling', () => {
  it('returns 500 with error format when engine throws', async () => {
    vi.mocked(getMessages).mockRejectedValueOnce(new Error('boom'));

    const res = await request(app)
      .get('/v1/channels/general/messages');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'boom' },
    });
  });

  it('returns 404 not_found for unknown route', async () => {
    const res = await request(app)
      .get('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  it('returns 400 invalid_json for malformed JSON body', async () => {
    const res = await request(app)
      .post('/v1/workspaces')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'invalid_json',
        message: 'Malformed JSON in request body',
      },
    });
  });

  it('fails POST /v1/workspaces when name is missing', async () => {
    const res = await request(app)
      .post('/v1/workspaces')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'name is required' },
    });
  });

  it('fails POST message when text is empty', async () => {
    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'text is required' },
    });
  });

  it('returns 409 when workspace name is duplicated (engine throws)', async () => {
    vi.mocked(createWorkspace).mockRejectedValueOnce({
      status: 409,
      code: 'workspace_name_taken',
      message: 'Workspace name already exists',
    });

    const res = await request(app)
      .post('/v1/workspaces')
      .send({ name: 'dup' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'workspace_name_taken', message: 'Workspace name already exists' },
    });
  });

  it('returns 404 when channel not found (engine throws)', async () => {
    vi.mocked(getChannel).mockRejectedValueOnce({
      status: 404,
      code: 'channel_not_found',
      message: 'Channel not found',
    });

    const res = await request(app)
      .get('/v1/channels/ghost');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'channel_not_found', message: 'Channel not found' },
    });
  });

  it('returns 404 when agent not found (engine throws)', async () => {
    vi.mocked(getAgentByName).mockRejectedValueOnce({
      status: 404,
      code: 'agent_not_found',
      message: 'Agent not found',
    });

    const res = await request(app)
      .get('/v1/agents/ghost');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'agent_not_found', message: 'Agent not found' },
    });
  });
});

describe('Large Payload Testing', () => {
  it('posts message with ~10KB text body', async () => {
    const text = 'a'.repeat(10 * 1024);
    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ id: 'msg_1' });

    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ text }),
    );
  });

  it('posts message with 50 attachments', async () => {
    const attachments = Array.from({ length: 50 }, (_v, i) => ({
      id: `file_${i}`,
      name: `file_${i}.txt`,
    }));

    const res = await request(app)
      .post('/v1/channels/general/messages')
      .send({ text: 'with attachments', attachments });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ id: 'msg_1' });

    expect(vi.mocked(postMessage)).toHaveBeenCalledWith(
      fakeWorkspace.id,
      'ch_1',
      fakeAgent.id,
      expect.objectContaining({ attachments }),
    );
  });

  it('creates workspace with large metadata object (ignored by route)', async () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      metadata[`k_${i}`] = 'x'.repeat(40);
    }

    const res = await request(app)
      .post('/v1/workspaces')
      .send({ name: 'big', metadata });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, data: { id: 'ws_new', name: 'new' } });

    expect(vi.mocked(createWorkspace)).toHaveBeenCalledWith('big');
  });
});

describe('Snowflake ID Testing', () => {
  it('generates 1000 unique IDs', () => {
    const gen = new SnowflakeGenerator(1);
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(gen.generate());
    expect(ids.size).toBe(1000);
  });

  it('generates monotonically increasing IDs', () => {
    const gen = new SnowflakeGenerator(1);
    let prev = BigInt(gen.generate());
    for (let i = 0; i < 200; i++) {
      const cur = BigInt(gen.generate());
      expect(cur > prev).toBe(true);
      prev = cur;
    }
  });

  it('generates unique IDs under concurrent generation', async () => {
    const gen = new SnowflakeGenerator(1);
    const ids = await Promise.all(
      Array.from({ length: 1000 }, () => Promise.resolve().then(() => gen.generate())),
    );
    expect(new Set(ids).size).toBe(1000);
  });
});

describe('Concurrent Request Testing', () => {
  it('handles 10 POST message requests in parallel', async () => {
    let n = 0;
    vi.mocked(postMessage).mockImplementation(async (_wsId: any, _chId: any, _agentId: any, body: any) => {
      n++;
      return { id: `msg_${n}`, echo: body.text };
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_v, i) =>
        request(app)
          .post('/v1/channels/general/messages')
          .send({ text: `hi ${i}` })),
    );

    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.data.id).toBe('string');
    }
    expect(vi.mocked(postMessage)).toHaveBeenCalledTimes(10);
  });

  it('handles 10 GET requests in parallel', async () => {
    vi.mocked(getMessages).mockResolvedValue([] as any);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).get('/v1/channels/general/messages')),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, data: [] });
    }
    expect(vi.mocked(getMessages)).toHaveBeenCalledTimes(10);
  });

  it('handles mixed read/write requests in parallel', async () => {
    vi.mocked(searchMessages).mockResolvedValue([] as any);

    const tasks = [
      ...Array.from({ length: 5 }, (_v, i) =>
        request(app)
          .post('/v1/channels/general/messages')
          .send({ text: `w${i}` })),
      ...Array.from({ length: 5 }, () =>
        request(app).get('/v1/channels/general/messages')),
      ...Array.from({ length: 5 }, (_v, i) =>
        request(app).get('/v1/search').query({ q: `q${i}` })),
    ];

    const responses = await Promise.all(tasks);

    for (let i = 0; i < 5; i++) {
      expect(responses[i].status).toBe(201);
      expect(responses[i].body.ok).toBe(true);
    }
    for (let i = 5; i < 10; i++) {
      expect(responses[i].status).toBe(200);
      expect(responses[i].body).toEqual({ ok: true, data: [] });
    }
    for (let i = 10; i < 15; i++) {
      expect(responses[i].status).toBe(200);
      expect(responses[i].body).toEqual({ ok: true, data: [] });
    }
  });
});

