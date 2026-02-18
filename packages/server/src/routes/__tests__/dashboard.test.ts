import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/activity.js', () => ({
  getActivityFeed: vi.fn(),
}));

vi.mock('../../engine/dmAll.js', () => ({
  listAllDmConversations: vi.fn(),
}));

vi.mock('../../engine/tokenRotate.js', () => ({
  rotateAgentToken: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { dashboardRoutes } from '../../routes/dashboard.js';
import * as activityEngine from '../../engine/activity.js';
import * as dmAllEngine from '../../engine/dmAll.js';
import * as tokenRotateEngine from '../../engine/tokenRotate.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  wsAuthHeaders,
  createMockBindings,
  FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  (c as any).env = { ...bindings };
  await next();
});
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', dashboardRoutes);
app.route('/v1', v1);

describe('Dashboard routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /v1/activity', () => {
    it('returns activity feed with default limit', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
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

      const res = await app.request('/v1/activity', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual(items);
      expect(activityEngine.getActivityFeed).toHaveBeenCalledWith(
        expect.anything(),
        FAKE_WORKSPACE.id,
        20,
      );
    });

    it('respects limit query parameter', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      vi.mocked(activityEngine.getActivityFeed).mockResolvedValue([]);

      const res = await app.request('/v1/activity?limit=5', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(200);
      expect(activityEngine.getActivityFeed).toHaveBeenCalledWith(
        expect.anything(),
        FAKE_WORKSPACE.id,
        5,
      );
    });

    it('returns 401 without auth', async () => {
      const res = await app.request('/v1/activity', { method: 'GET' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/dm/conversations/all', () => {
    it('returns workspace-wide DM conversations', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      const conversations = [
        {
          channel_id: 'ch_1',
          participants: ['Alice', 'Bob'],
          message_count: 10,
          last_message_at: '2025-01-01T00:00:00Z',
        },
      ];
      vi.mocked(dmAllEngine.listAllDmConversations).mockResolvedValue(conversations);

      const res = await app.request('/v1/dm/conversations/all', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual(conversations);
    });

    it('returns 401 without auth', async () => {
      const res = await app.request('/v1/dm/conversations/all', { method: 'GET' });
      expect(res.status).toBe(401);
    });

    it('handles engine errors', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      vi.mocked(dmAllEngine.listAllDmConversations).mockRejectedValue(
        new Error('DB error'),
      );

      const res = await app.request('/v1/dm/conversations/all', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  describe('POST /v1/agents/:name/rotate-token', () => {
    it('rotates agent token and returns new token', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      vi.mocked(tokenRotateEngine.rotateAgentToken).mockResolvedValue({
        token: 'at_live_newtoken123',
      });

      const res = await app.request('/v1/agents/TestBot/rotate-token', {
        method: 'POST',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.token).toBe('at_live_newtoken123');
      expect(tokenRotateEngine.rotateAgentToken).toHaveBeenCalledWith(
        expect.anything(),
        FAKE_WORKSPACE.id,
        'TestBot',
      );
    });

    it('returns 401 without auth', async () => {
      const res = await app.request('/v1/agents/TestBot/rotate-token', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('handles agent not found error', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      const err = Object.assign(new Error('Agent not found'), {
        code: 'not_found',
        status: 404,
      });
      vi.mocked(tokenRotateEngine.rotateAgentToken).mockRejectedValue(err);

      const res = await app.request('/v1/agents/unknown/rotate-token', {
        method: 'POST',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('not_found');
    });
  });
});
