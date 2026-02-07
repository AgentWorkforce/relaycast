import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('../../engine/channel.js', () => ({
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

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  })),
}));

import { app } from '../../app.js';
import * as messageEngine from '../../engine/message.js';
import * as channelEngine from '../../engine/channel.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: hashToken('rk_live_dummy'),
  systemPrompt: null,
  plan: 'free',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  createdAt: new Date(),
  metadata: {},
};

const fakeAgent = {
  id: 'agent_456',
  workspaceId: 'ws_123',
  name: 'TestBot',
  type: 'agent',
  tokenHash: agentTokenHash,
  status: 'online',
  persona: null,
  metadata: {},
  createdAt: new Date(),
  lastSeen: new Date(),
};

function mockDbForAgentAuth() {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();

  // For at_live_ tokens: first call is agent lookup, second call is workspace lookup
  let callCount = 0;
  mockWhere.mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([fakeAgent]);
    return Promise.resolve([fakeWorkspace]);
  });

  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });

  vi.mocked(getDb).mockReturnValue({
    select: mockSelect,
  } as ReturnType<typeof getDb>);
}

const fakeChannel = {
  id: 'ch_789',
  name: 'general',
  topic: null,
  member_count: 1,
  members: [],
  created_at: '2025-01-01T00:00:00.000Z',
  is_archived: false,
};

describe('POST /v1/channels/:name/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
    vi.mocked(channelEngine.getChannel).mockResolvedValue(fakeChannel);
  });

  it('posts a message and returns 201', async () => {
    vi.mocked(messageEngine.postMessage).mockResolvedValue({
      id: 'msg_001',
      channel_id: 'ch_789',
      agent_id: 'agent_456',
      text: 'Hello world',
      has_attachments: false,
      thread_id: null,
      created_at: '2025-01-01T00:00:00.000Z',
      mentions: [],
    });

    const res = await request(app)
      .post('/v1/channels/general/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ text: 'Hello world' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.text).toBe('Hello world');
    expect(res.body.data.id).toBe('msg_001');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(app)
      .post('/v1/channels/general/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 404 when channel not found', async () => {
    vi.mocked(channelEngine.getChannel).mockResolvedValue(null);

    const res = await request(app)
      .post('/v1/channels/nonexistent/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ text: 'Hello' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('channel_not_found');
  });
});

describe('GET /v1/channels/:name/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
    vi.mocked(channelEngine.getChannel).mockResolvedValue(fakeChannel);
  });

  it('returns messages array', async () => {
    vi.mocked(messageEngine.getMessages).mockResolvedValue([
      {
        id: 'msg_001',
        channel_id: 'ch_789',
        agent_id: 'agent_456',
        text: 'Hello',
        has_attachments: false,
        thread_id: null,
        created_at: '2025-01-01T00:00:00.000Z',
        reply_count: 0,
        reactions: [],
        read_by_count: 0,
      },
    ]);

    const res = await request(app)
      .get('/v1/channels/general/messages')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].text).toBe('Hello');
  });

  it('passes pagination params correctly', async () => {
    vi.mocked(messageEngine.getMessages).mockResolvedValue([]);

    await request(app)
      .get('/v1/channels/general/messages?limit=10&before=msg_050')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(messageEngine.getMessages).toHaveBeenCalledWith(
      'ws_123',
      'ch_789',
      { limit: 10, before: 'msg_050', after: undefined },
    );
  });
});

describe('GET /v1/messages/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns a single message', async () => {
    vi.mocked(messageEngine.getMessage).mockResolvedValue({
      id: 'msg_001',
      channel_id: 'ch_789',
      agent_id: 'agent_456',
      text: 'Hello',
      has_attachments: false,
      thread_id: null,
      created_at: '2025-01-01T00:00:00.000Z',
      reply_count: 0,
      reactions: [],
      read_by_count: 0,
    });

    const res = await request(app)
      .get('/v1/messages/msg_001')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('msg_001');
  });

  it('returns 404 for unknown message', async () => {
    vi.mocked(messageEngine.getMessage).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/messages/unknown_id')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });
});

