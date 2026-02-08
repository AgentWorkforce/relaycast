import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../engine/stats.js', () => ({
  getWorkspaceStats: vi.fn(),
}));

vi.mock('../../engine/activity.js', () => ({
  getActivityFeed: vi.fn(),
}));

vi.mock('../../engine/dmAll.js', () => ({
  listAllDmConversations: vi.fn(),
}));

vi.mock('../../engine/tokenRotate.js', () => ({
  rotateAgentToken: vi.fn(),
}));

vi.mock('../../engine/presence.js', () => ({
  getPresence: vi.fn(),
}));

vi.mock('../../engine/workspace.js', () => ({
  createWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
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

vi.mock('../../engine/systemPrompt.js', () => ({
  getSystemPrompt: vi.fn(),
  setSystemPrompt: vi.fn(),
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
import * as statsEngine from '../../engine/stats.js';
import * as activityEngine from '../../engine/activity.js';
import * as dmAllEngine from '../../engine/dmAll.js';
import * as tokenRotateEngine from '../../engine/tokenRotate.js';
import { getDb } from '../../db/index.js';
import { hashToken } from '../../middleware/auth.js';
import crypto from 'node:crypto';

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

function mockDbForWorkspaceAuth() {
  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue([fakeWorkspace]),
      }),
    }),
  } as ReturnType<typeof getDb>);
}

describe('Dashboard routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /v1/workspace/stats', () => {
    it('returns aggregated workspace stats', async () => {
      mockDbForWorkspaceAuth();
      vi.mocked(statsEngine.getWorkspaceStats).mockResolvedValue({
        agents: 5,
        channels: 3,
        messages: 120,
        dm_conversations: 8,
        files: 2,
      });

      const res = await request(app)
        .get('/v1/workspace/stats')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual({
        agents: 5,
        channels: 3,
        messages: 120,
        dm_conversations: 8,
        files: 2,
      });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/workspace/stats');
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    });

    it('handles engine errors', async () => {
      mockDbForWorkspaceAuth();
      vi.mocked(statsEngine.getWorkspaceStats).mockRejectedValue(
        new Error('DB connection failed'),
      );

      const res = await request(app)
        .get('/v1/workspace/stats')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('internal_error');
    });
  });

  describe('GET /v1/activity', () => {
    it('returns activity feed with default limit', async () => {
      mockDbForWorkspaceAuth();
      const items = [
        {
          id: 'msg_1',
          channel_name: 'general',
          agent_name: 'Alice',
          body: 'Hello',
          is_dm: false,
          created_at: '2025-01-01T00:00:00Z',
        },
      ];
      vi.mocked(activityEngine.getActivityFeed).mockResolvedValue(items);

      const res = await request(app)
        .get('/v1/activity')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual(items);
      expect(activityEngine.getActivityFeed).toHaveBeenCalledWith('ws_123', 20);
    });

    it('respects limit query parameter', async () => {
      mockDbForWorkspaceAuth();
      vi.mocked(activityEngine.getActivityFeed).mockResolvedValue([]);

      const res = await request(app)
        .get('/v1/activity?limit=5')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(200);
      expect(activityEngine.getActivityFeed).toHaveBeenCalledWith('ws_123', 5);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/activity');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/dm/conversations/all', () => {
    it('returns workspace-wide DM conversations', async () => {
      mockDbForWorkspaceAuth();
      const conversations = [
        {
          channel_id: 'ch_1',
          participants: ['Alice', 'Bob'],
          message_count: 10,
          last_message_at: '2025-01-01T00:00:00Z',
        },
      ];
      vi.mocked(dmAllEngine.listAllDmConversations).mockResolvedValue(conversations);

      const res = await request(app)
        .get('/v1/dm/conversations/all')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual(conversations);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/v1/dm/conversations/all');
      expect(res.status).toBe(401);
    });

    it('handles engine errors', async () => {
      mockDbForWorkspaceAuth();
      vi.mocked(dmAllEngine.listAllDmConversations).mockRejectedValue(
        new Error('DB error'),
      );

      const res = await request(app)
        .get('/v1/dm/conversations/all')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('POST /v1/agents/:name/rotate-token', () => {
    it('rotates agent token and returns new token', async () => {
      mockDbForWorkspaceAuth();
      vi.mocked(tokenRotateEngine.rotateAgentToken).mockResolvedValue({
        token: 'at_live_newtoken123',
      });

      const res = await request(app)
        .post('/v1/agents/TestBot/rotate-token')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.token).toBe('at_live_newtoken123');
      expect(tokenRotateEngine.rotateAgentToken).toHaveBeenCalledWith(
        'ws_123',
        'TestBot',
      );
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/v1/agents/TestBot/rotate-token');
      expect(res.status).toBe(401);
    });

    it('handles agent not found error', async () => {
      mockDbForWorkspaceAuth();
      const err = Object.assign(new Error('Agent not found'), {
        code: 'not_found',
        status: 404,
      });
      vi.mocked(tokenRotateEngine.rotateAgentToken).mockRejectedValue(err);

      const res = await request(app)
        .post('/v1/agents/unknown/rotate-token')
        .set('Authorization', `Bearer ${workspaceKey}`);

      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe('not_found');
    });
  });
});
