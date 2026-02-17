import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as workspaceEngine from '../engine/workspace.js';

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
