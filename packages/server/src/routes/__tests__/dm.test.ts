import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getDmMessages: vi.fn(),
}));

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

vi.mock('../../engine/presence.js', () => ({
  getPresence: vi.fn(),
}));

vi.mock('../../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
}));

vi.mock('../../engine/billing.js', () => ({
  subscribe: vi.fn(),
  getSubscription: vi.fn(),
  getUsage: vi.fn(),
  getInvoices: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('../../engine/webhooks.js', () => ({
  processWebhook: vi.fn(),
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
import * as dmEngine from '../../engine/dm.js';
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

describe('POST /v1/dm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('sends a DM and returns 201', async () => {
    vi.mocked(dmEngine.sendDm).mockResolvedValue({
      id: 'msg_001',
      conversation_id: 'conv_123',
      from_agent_id: 'agent_456',
      to: 'OtherBot',
      text: 'Hello DM',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/dm')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ to: 'OtherBot', text: 'Hello DM' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.conversation_id).toBe('conv_123');
  });

  it('returns 400 when to is missing', async () => {
    const res = await request(app)
      .post('/v1/dm')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ text: 'Hello' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(app)
      .post('/v1/dm')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ to: 'OtherBot' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('GET /v1/dm/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('lists conversations', async () => {
    vi.mocked(dmEngine.listConversations).mockResolvedValue([
      {
        id: 'conv_123',
        dm_type: '1:1',
        name: null,
        participants: [
          { agent_id: 'agent_456', agent_name: 'TestBot' },
          { agent_id: 'agent_789', agent_name: 'OtherBot' },
        ],
        last_message: {
          id: 'msg_001',
          text: 'Hello',
          agent_id: 'agent_456',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        unread_count: 3,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .get('/v1/dm/conversations')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].participants).toHaveLength(2);
  });
});

describe('GET /v1/dm/:conversation_id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns paginated messages', async () => {
    vi.mocked(dmEngine.getDmMessages).mockResolvedValue([
      {
        id: 'msg_001',
        agent_id: 'agent_456',
        text: 'Hello',
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await request(app)
      .get('/v1/dm/conv_123/messages')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(dmEngine.getDmMessages).mockRejectedValue(
      Object.assign(new Error('Not a participant in this conversation'), {
        code: 'forbidden',
        status: 403,
      }),
    );

    const res = await request(app)
      .get('/v1/dm/conv_123/messages')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

