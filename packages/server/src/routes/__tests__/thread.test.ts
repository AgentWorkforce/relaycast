import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/thread.js', () => ({
  postReply: vi.fn(),
  getThread: vi.fn(),
}));

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

vi.mock('../../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getConversationMessages: vi.fn(),
}));

vi.mock('../../engine/groupDm.js', () => ({
  createGroupDm: vi.fn(),
  postToGroupDm: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
}));

vi.mock('../../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
}));

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
}));

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
}));

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../engine/receipt.js', () => ({
  markRead: vi.fn(),
  getReaders: vi.fn(),
  getReadStatus: vi.fn(),
}));

vi.mock('../../engine/file.js', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
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
import * as threadEngine from '../../engine/thread.js';
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
  const mockWhere = vi.fn();
  let callCount = 0;
  mockWhere.mockImplementation(() => {
    callCount++;
    if (callCount === 1) return Promise.resolve([fakeWorkspace]);
    return Promise.resolve([fakeAgent]);
  });

  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: mockWhere,
      }),
    }),
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/messages/:id/replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('creates a reply and returns 201', async () => {
    vi.mocked(threadEngine.postReply).mockResolvedValue({
      id: 'reply_001',
      channel_id: 'ch_789',
      agent_id: 'agent_456',
      thread_id: 'msg_001',
      text: 'This is a reply',
      has_attachments: false,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/messages/msg_001/replies')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ text: 'This is a reply' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.thread_id).toBe('msg_001');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(app)
      .post('/v1/messages/msg_001/replies')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 404 for unknown parent message', async () => {
    vi.mocked(threadEngine.postReply).mockRejectedValue(
      Object.assign(new Error('Parent message not found'), {
        code: 'message_not_found',
        status: 404,
      }),
    );

    const res = await request(app)
      .post('/v1/messages/unknown/replies')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ text: 'Reply' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });
});

describe('GET /v1/messages/:id/replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns parent + replies', async () => {
    vi.mocked(threadEngine.getThread).mockResolvedValue({
      parent: {
        id: 'msg_001',
        channel_id: 'ch_789',
        agent_id: 'agent_456',
        text: 'Original message',
        has_attachments: false,
        thread_id: null,
        created_at: '2025-01-01T00:00:00.000Z',
        reply_count: 2,
      },
      replies: [
        {
          id: 'reply_001',
          channel_id: 'ch_789',
          agent_id: 'agent_456',
          thread_id: 'msg_001',
          text: 'First reply',
          has_attachments: false,
          created_at: '2025-01-01T00:01:00.000Z',
        },
        {
          id: 'reply_002',
          channel_id: 'ch_789',
          agent_id: 'agent_456',
          thread_id: 'msg_001',
          text: 'Second reply',
          has_attachments: false,
          created_at: '2025-01-01T00:02:00.000Z',
        },
      ],
    });

    const res = await request(app)
      .get('/v1/messages/msg_001/replies')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.parent.id).toBe('msg_001');
    expect(res.body.data.parent.reply_count).toBe(2);
    expect(res.body.data.replies).toHaveLength(2);
  });

  it('returns 404 for unknown parent', async () => {
    vi.mocked(threadEngine.getThread).mockRejectedValue(
      Object.assign(new Error('Parent message not found'), {
        code: 'message_not_found',
        status: 404,
      }),
    );

    const res = await request(app)
      .get('/v1/messages/unknown/replies')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });
});
