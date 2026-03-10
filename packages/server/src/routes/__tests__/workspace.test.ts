import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/activity.js', () => ({
  getActivityFeed: vi.fn(),
}));

vi.mock('../../engine/dmAll.js', () => ({
  listAllDmConversations: vi.fn(),
  getDmMessagesForWorkspace: vi.fn(),
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
import { workspaceRoutes } from '../../routes/workspace.js';
import * as activityEngine from '../../engine/activity.js';
import * as dmAllEngine from '../../engine/dmAll.js';
import * as tokenRotateEngine from '../../engine/tokenRotate.js';
import * as workspaceEngine from '../../engine/workspace.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  wsAuthHeaders,
  createMockBindings,
  createMockKV,
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
v1.route('/', workspaceRoutes);
app.route('/v1', v1);

describe('Dashboard routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /v1/workspaces', () => {
    it('creates a workspace without route-level duplicate name checks', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      vi.spyOn(workspaceEngine, 'createWorkspace').mockResolvedValue({
        workspace_id: 'ws_new',
        api_key: 'rk_live_test',
        created_at: '2026-03-10T00:00:00.000Z',
      });

      const res = await app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'my-project' }),
      });

      expect(res.status).toBe(201);
      expect(workspaceEngine.createWorkspace).toHaveBeenCalledWith(
        expect.anything(),
        'my-project',
      );
    });
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

  describe('GET /v1/dm/conversations/:conversation_id/messages', () => {
    it('returns DM messages with agent_name', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
      vi.mocked(dmAllEngine.getDmMessagesForWorkspace).mockResolvedValue([
        {
          id: 'msg_1',
          agent_id: 'agent_1',
          agent_name: 'Alice',
          text: 'hello',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ]);

      const res = await app.request('/v1/dm/conversations/c_1/messages', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data[0].agent_name).toBe('Alice');
      expect(dmAllEngine.getDmMessagesForWorkspace).toHaveBeenCalledWith(
        expect.anything(),
        FAKE_WORKSPACE.id,
        'c_1',
        { limit: undefined, before: undefined, after: undefined },
      );
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

  describe('Workspace stream toggle', () => {
    beforeEach(() => {
      (bindings as any).KV = createMockKV();
    });

    it('returns effective stream config', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

      const res = await app.request('/v1/workspace/stream', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({
        enabled: false,
        default_enabled: false,
        override: null,
      });
    });

    it('enables stream override with PUT', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

      const putRes = await app.request('/v1/workspace/stream', {
        method: 'PUT',
        headers: wsAuthHeaders(),
        body: JSON.stringify({ enabled: true }),
      });
      expect(putRes.status).toBe(200);
      const putBody = await putRes.json();
      expect(putBody.data.enabled).toBe(true);
      expect(putBody.data.override).toBe(true);

      const getRes = await app.request('/v1/workspace/stream', {
        method: 'GET',
        headers: wsAuthHeaders(),
      });
      const getBody = await getRes.json();
      expect(getBody.data.enabled).toBe(true);
      expect(getBody.data.override).toBe(true);
    });

    it('clears override with inherit mode', async () => {
      vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());

      await app.request('/v1/workspace/stream', {
        method: 'PUT',
        headers: wsAuthHeaders(),
        body: JSON.stringify({ enabled: true }),
      });

      const inheritRes = await app.request('/v1/workspace/stream', {
        method: 'PUT',
        headers: wsAuthHeaders(),
        body: JSON.stringify({ mode: 'inherit' }),
      });
      expect(inheritRes.status).toBe(200);
      const inheritBody = await inheritRes.json();
      expect(inheritBody.data.enabled).toBe(false);
      expect(inheritBody.data.override).toBeNull();
    });
  });
});
