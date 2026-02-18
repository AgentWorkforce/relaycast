import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as workspaceEngine from '../engine/workspace.js';
import * as activityEngine from '../engine/activity.js';
import * as dmAllEngine from '../engine/dmAll.js';
import * as tokenRotateEngine from '../engine/tokenRotate.js';

export const workspaceRoutes = new Hono<AppEnv>();

// POST /workspaces - create workspace (no auth required)
workspaceRoutes.post('/workspaces', async (c) => {
  try {
    const { name } = await c.req.json();
    if (!name || typeof name !== 'string') {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'name is required' } }, 400);
    }
    const db = c.get('db');
    const result = await workspaceEngine.createWorkspace(db, name);
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// GET /workspace - get current workspace
workspaceRoutes.get('/workspace', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = await workspaceEngine.getWorkspace(db, c.get('workspace').id);
    if (!workspace) {
      return c.json({ ok: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404);
    }
    return c.json({ ok: true, data: workspace });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// PATCH /workspace - update workspace
workspaceRoutes.patch('/workspace', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const body = await c.req.json();
    const updated = await workspaceEngine.updateWorkspace(db, c.get('workspace').id, body);
    if (!updated) {
      return c.json({ ok: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404);
    }
    return c.json({ ok: true, data: updated });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// DELETE /workspace - delete workspace
workspaceRoutes.delete('/workspace', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    await workspaceEngine.deleteWorkspace(db, c.get('workspace').id);
    return c.body(null, 204);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// GET /activity — recent activity feed
workspaceRoutes.get('/activity', requireWorkspaceKey, rateLimit, async (c) => {
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

// GET /dm/conversations/all — workspace-wide DM list
workspaceRoutes.get('/dm/conversations/all', requireWorkspaceKey, rateLimit, async (c) => {
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

// GET /dm/conversations/:conversation_id/messages — DM messages by conversation
workspaceRoutes.get('/dm/conversations/:conversation_id/messages', requireWorkspaceKey, rateLimit, async (c) => {
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

// POST /agents/:name/rotate-token — token rotation
workspaceRoutes.post('/agents/:name/rotate-token', requireWorkspaceKey, rateLimit, async (c) => {
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
