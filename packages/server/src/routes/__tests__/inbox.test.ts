import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/inbox.js', () => ({
  getInbox: vi.fn(),
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

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
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
import * as inboxEngine from '../../engine/inbox.js';
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

describe('GET /v1/inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbForAgentAuth();
  });

  it('returns inbox with unread channels, mentions, and DMs', async () => {
    vi.mocked(inboxEngine.getInbox).mockResolvedValue({
      unread_channels: [
        { channel_name: 'general', unread_count: 5 },
        { channel_name: 'code-review', unread_count: 2 },
      ],
      mentions: [
        {
          id: 'msg_010',
          channel_name: 'general',
          agent_name: 'Alice',
          text: 'Hey @TestBot check this out',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      unread_dms: [
        {
          conversation_id: 'dm_001',
          from: 'Alice',
          unread_count: 3,
          last_message: {
            id: 'msg_020',
            text: 'Can you review this?',
            created_at: '2025-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    const res = await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unread_channels).toHaveLength(2);
    expect(res.body.data.unread_channels[0].channel_name).toBe('general');
    expect(res.body.data.unread_channels[0].unread_count).toBe(5);
    expect(res.body.data.mentions).toHaveLength(1);
    expect(res.body.data.mentions[0].text).toContain('@TestBot');
    expect(res.body.data.unread_dms).toHaveLength(1);
    expect(res.body.data.unread_dms[0].from).toBe('Alice');
  });

  it('returns empty inbox when nothing unread', async () => {
    vi.mocked(inboxEngine.getInbox).mockResolvedValue({
      unread_channels: [],
      mentions: [],
      unread_dms: [],
    });

    const res = await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.unread_channels).toEqual([]);
    expect(res.body.data.mentions).toEqual([]);
    expect(res.body.data.unread_dms).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/v1/inbox');
    expect(res.status).toBe(401);
  });

  it('returns 401 with workspace key (requires agent token)', async () => {
    const mockSelect = vi.fn();
    const mockFrom = vi.fn();
    const mockWhere = vi.fn();
    mockWhere.mockResolvedValue([fakeWorkspace]);
    mockFrom.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });
    vi.mocked(getDb).mockReturnValue({
      select: mockSelect,
    } as ReturnType<typeof getDb>);

    const res = await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${workspaceKey}`);

    expect(res.status).toBe(401);
  });

  it('calls getInbox with correct workspace and agent IDs', async () => {
    vi.mocked(inboxEngine.getInbox).mockResolvedValue({
      unread_channels: [],
      mentions: [],
      unread_dms: [],
    });

    await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(inboxEngine.getInbox).toHaveBeenCalledWith('ws_123', 'agent_456');
  });

  it('handles engine errors gracefully', async () => {
    vi.mocked(inboxEngine.getInbox).mockRejectedValue(new Error('DB connection failed'));

    const res = await request(app)
      .get('/v1/inbox')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('internal_error');
  });
});
