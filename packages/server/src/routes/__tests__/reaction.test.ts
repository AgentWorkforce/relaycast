import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
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

vi.mock('../../engine/message.js', () => ({
  postMessage: vi.fn(),
  getMessages: vi.fn(),
  getMessage: vi.fn(),
}));

vi.mock('../../engine/thread.js', () => ({
  postReply: vi.fn(),
  getReplies: vi.fn(),
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

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
}));

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
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

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
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
import * as reactionEngine from '../../engine/reaction.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
const agentTokenHash = hashToken(agentToken);
const workspaceKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
const workspaceKeyHash = hashToken(workspaceKey);

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: workspaceKeyHash,
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

function mockDbForWorkspaceAuth() {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  mockWhere.mockResolvedValue([fakeWorkspace]);
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  vi.mocked(getDb).mockReturnValue({
    select: mockSelect,
  } as ReturnType<typeof getDb>);
}

describe('POST /v1/messages/:id/reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('adds a reaction and returns 201', async () => {
    vi.mocked(reactionEngine.addReaction).mockResolvedValue({
      id: 'rxn_001',
      message_id: 'msg_001',
      agent_name: 'TestBot',
      emoji: 'eyes',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ emoji: 'eyes' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.emoji).toBe('eyes');
    expect(res.body.data.agent_name).toBe('TestBot');
    expect(reactionEngine.addReaction).toHaveBeenCalledWith('ws_123', 'msg_001', 'agent_456', 'eyes');
  });

  it('is idempotent (same emoji twice returns 201)', async () => {
    vi.mocked(reactionEngine.addReaction).mockResolvedValue({
      id: 'rxn_001',
      message_id: 'msg_001',
      agent_name: 'TestBot',
      emoji: 'eyes',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res1 = await request(app)
      .post('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ emoji: 'eyes' });
    const res2 = await request(app)
      .post('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ emoji: 'eyes' });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });

  it('returns 400 when emoji is missing', async () => {
    const res = await request(app)
      .post('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(reactionEngine.addReaction).mockResolvedValue(null);

    const res = await request(app)
      .post('/v1/messages/msg_999/reactions')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ emoji: 'eyes' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/v1/messages/msg_001/reactions')
      .send({ emoji: 'eyes' });

    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/messages/:id/reactions/:emoji', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('removes a reaction and returns 204', async () => {
    vi.mocked(reactionEngine.removeReaction).mockResolvedValue(true);

    const res = await request(app)
      .delete('/v1/messages/msg_001/reactions/eyes')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(204);
    expect(reactionEngine.removeReaction).toHaveBeenCalledWith('ws_123', 'msg_001', 'agent_456', 'eyes');
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(reactionEngine.removeReaction).mockResolvedValue(null);

    const res = await request(app)
      .delete('/v1/messages/msg_999/reactions/eyes')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });
});

describe('GET /v1/messages/:id/reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns aggregated reactions with agent token', async () => {
    mockDbForAgentAuth();
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([
      { emoji: 'eyes', count: 2, agents: ['Alice', 'Bob'] },
      { emoji: 'fire', count: 1, agents: ['Carol'] },
    ]);

    const res = await request(app)
      .get('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].emoji).toBe('eyes');
    expect(res.body.data[0].count).toBe(2);
    expect(res.body.data[0].agents).toEqual(['Alice', 'Bob']);
  });

  it('works with workspace key (requireAuth)', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([
      { emoji: 'thumbsup', count: 3, agents: ['Alice', 'Bob', 'Carol'] },
    ]);

    const res = await request(app)
      .get('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[0].count).toBe(3);
  });

  it('returns 404 when message not found', async () => {
    mockDbForAgentAuth();
    vi.mocked(reactionEngine.getReactions).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/messages/msg_999/reactions')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });

  it('returns empty array when no reactions', async () => {
    mockDbForAgentAuth();
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns correct counts for multiple agents on same emoji', async () => {
    mockDbForAgentAuth();
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([
      { emoji: 'eyes', count: 3, agents: ['Alice', 'Bob', 'Carol'] },
    ]);

    const res = await request(app)
      .get('/v1/messages/msg_001/reactions')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.body.data[0].count).toBe(3);
    expect(res.body.data[0].agents).toHaveLength(3);
  });
});
