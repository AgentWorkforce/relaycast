import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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

import { app } from '../../app.js';
import * as receiptEngine from '../../engine/receipt.js';
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

describe('POST /v1/messages/:id/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('marks read and returns 200', async () => {
    vi.mocked(receiptEngine.markRead).mockResolvedValue({
      message_id: 'msg_001',
      agent_id: 'agent_456',
      read_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/v1/messages/msg_001/read')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.message_id).toBe('msg_001');
    expect(res.body.data.agent_id).toBe('agent_456');
    expect(receiptEngine.markRead).toHaveBeenCalledWith('ws_123', 'msg_001', 'agent_456');
  });

  it('is idempotent', async () => {
    vi.mocked(receiptEngine.markRead).mockResolvedValue({
      message_id: 'msg_001',
      agent_id: 'agent_456',
      read_at: '2025-01-01T00:00:00.000Z',
    });

    const res1 = await request(app)
      .post('/v1/messages/msg_001/read')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    mockDbForAgentAuth();
    const res2 = await request(app)
      .post('/v1/messages/msg_001/read')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(receiptEngine.markRead).mockResolvedValue(null);

    const res = await request(app)
      .post('/v1/messages/msg_999/read')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('message_not_found');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/v1/messages/msg_001/read')
      .send({});

    expect(res.status).toBe(401);
  });

  it('returns 401 with workspace key (requires agent token)', async () => {
    mockDbForWorkspaceAuth();
    const res = await request(app)
      .post('/v1/messages/msg_001/read')
      .set('Authorization', `Bearer ${workspaceKey}`)
      .send({});

    expect(res.status).toBe(401);
  });
});

describe('GET /v1/messages/:id/readers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns list of readers with agent token', async () => {
    mockDbForAgentAuth();
    vi.mocked(receiptEngine.getReaders).mockResolvedValue([
      { agent_name: 'TestBot', read_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await request(app)
      .get('/v1/messages/msg_001/readers')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([
      { agent_name: 'TestBot', read_at: '2025-01-01T00:00:00.000Z' },
    ]);
  });

  it('returns list of readers with workspace key', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(receiptEngine.getReaders).mockResolvedValue([
      { agent_name: 'TestBot', read_at: '2025-01-01T00:00:00.000Z' },
    ]);

    const res = await request(app)
      .get('/v1/messages/msg_001/readers')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 when message not found', async () => {
    mockDbForAgentAuth();
    vi.mocked(receiptEngine.getReaders).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/messages/msg_999/readers')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
  });

  it('returns empty array when no readers', async () => {
    mockDbForAgentAuth();
    vi.mocked(receiptEngine.getReaders).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/messages/msg_001/readers')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /v1/channels/:name/read-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-member read positions', async () => {
    mockDbForAgentAuth();
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue([
      { agent_name: 'TestBot', last_read_id: '100' },
    ]);

    const res = await request(app)
      .get('/v1/channels/general/read-status')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual([
      { agent_name: 'TestBot', last_read_id: '100' },
    ]);
  });

  it('works with workspace key', async () => {
    mockDbForWorkspaceAuth();
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/channels/general/read-status')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(200);
  });

  it('returns 404 when channel not found', async () => {
    mockDbForAgentAuth();
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue(null);

    const res = await request(app)
      .get('/v1/channels/missing/read-status')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('channel_not_found');
  });

  it('returns empty array for channel with no members', async () => {
    mockDbForAgentAuth();
    vi.mocked(receiptEngine.getReadStatus).mockResolvedValue([]);

    const res = await request(app)
      .get('/v1/channels/empty/read-status')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
