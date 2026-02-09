import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
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

vi.mock('../../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
}));

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
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

vi.mock('../../ws/pubsub.js', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../engine/eventDelivery.js', () => ({
  deliverEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../engine/eventQueue.js', () => ({
  enqueueEvent: vi.fn().mockResolvedValue('evt_mock'),
}));

import { app } from '../../app.js';
import * as searchEngine from '../../engine/search.js';
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

describe('GET /v1/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns search results', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([
      {
        id: 'msg_001',
        channel_name: 'general',
        agent_name: 'Alice',
        text: 'deployment error occurred',
        created_at: '2025-01-01T00:00:00.000Z',
        relevance_score: 0.85,
      },
    ]);

    const res = await request(app)
      .get('/v1/search?q=deployment+error')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].text).toContain('deployment error');
    expect(res.body.data[0].relevance_score).toBe(0.85);
  });

  it('returns 400 when q is missing', async () => {
    const res = await request(app)
      .get('/v1/search')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('returns 400 when q is empty string', async () => {
    const res = await request(app)
      .get('/v1/search?q=')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('passes filters to engine', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    await request(app)
      .get('/v1/search?q=test&channel=general&from=Alice&limit=10')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(searchEngine.searchMessages).toHaveBeenCalledWith('ws_123', {
      q: 'test',
      channel: 'general',
      from: 'Alice',
      limit: 10,
      before: undefined,
      after: undefined,
    });
  });

  it('returns empty array for no results', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/search?q=nonexistentterm')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('works with workspace key (requireAuth)', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/search?q=test')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('passes cursor pagination params', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    await request(app)
      .get('/v1/search?q=test&before=msg_100&after=msg_050')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(searchEngine.searchMessages).toHaveBeenCalledWith('ws_123', {
      q: 'test',
      channel: undefined,
      from: undefined,
      limit: undefined,
      before: 'msg_100',
      after: 'msg_050',
    });
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/search?q=test');
    expect(res.status).toBe(401);
  });

  it('handles engine errors gracefully', async () => {
    vi.mocked(searchEngine.searchMessages).mockRejectedValue(new Error('Search failed'));

    const res = await request(app)
      .get('/v1/search?q=test')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('internal_error');
  });
});
