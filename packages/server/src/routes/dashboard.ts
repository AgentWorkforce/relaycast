import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as activityEngine from '../engine/activity.js';
import * as dmAllEngine from '../engine/dmAll.js';
import * as tokenRotateEngine from '../engine/tokenRotate.js';

export const dashboardRoutes = new Hono<AppEnv>();

// GET /v1/activity — recent activity feed
dashboardRoutes.get('/activity', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 20;

    const items = await activityEngine.getActivityFeed(db, workspace.id, limit);
    return c.json({ ok: true, data: items });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /v1/dm/conversations/all — workspace-wide DM list
dashboardRoutes.get('/dm/conversations/all', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const conversations = await dmAllEngine.listAllDmConversations(db, workspace.id);
    return c.json({ ok: true, data: conversations });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /v1/dm/conversations/:conversation_id/messages — DM messages for dashboard (workspace key)
dashboardRoutes.get('/dm/conversations/:conversation_id/messages', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const conversationId = c.req.param('conversation_id');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const before = c.req.query('before') || undefined;
    const after = c.req.query('after') || undefined;

    const msgs = await dmAllEngine.getDmMessagesForWorkspace(
      db, workspace.id, conversationId, { limit, before, after },
    );
    return c.json({ ok: true, data: msgs });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// POST /v1/agents/:name/rotate-token — token rotation
dashboardRoutes.post('/agents/:name/rotate-token', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await tokenRotateEngine.rotateAgentToken(
      db,
      workspace.id,
      c.req.param('name'),
    );
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
