import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as workspaceEngine from '../engine/workspace.js';
import * as activityEngine from '../engine/activity.js';
import * as dmAllEngine from '../engine/dmAll.js';
import * as tokenRotateEngine from '../engine/tokenRotate.js';
import {
  getWorkspaceStreamConfig,
  setWorkspaceStreamOverride,
} from '../lib/workspaceStream.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const workspaceRoutes = new Hono<AppEnv>();

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
});

const updateWorkspaceSchema = z.object({
  name: z.string().optional(),
  system_prompt: z.string().nullable().optional(),
});

const updateWorkspaceStreamSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.string().optional(),
}).passthrough();

// POST /workspaces - create workspace (no auth required)
workspaceRoutes.post('/workspaces', async (c) => {
  try {
    const parsed = createWorkspaceSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'name is required' } }, 400);
    }
    const { name } = parsed.data;
    const db = c.get('db');
    const result = await workspaceEngine.createWorkspace(db, name);
    emitServerEvent(c, result.workspace_id, 'relaycast_server_workspace_created', {
      created_via: 'api',
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

// GET /workspaces/by-name/:name - lookup public workspace metadata by name
workspaceRoutes.get('/workspaces/by-name/:name', async (c) => {
  try {
    const db = c.get('db');
    const workspace = await workspaceEngine.getWorkspaceByName(db, c.req.param('name'));
    if (!workspace) {
      return c.json({ ok: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404);
    }
    return c.json({ ok: true, data: workspace });
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
    const workspace = c.get('workspace');
    const parsed = updateWorkspaceSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'invalid workspace update body' } }, 400);
    }
    const body = parsed.data;
    const updated = await workspaceEngine.updateWorkspace(db, workspace.id, body);
    if (!updated) {
      return c.json({ ok: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404);
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_workspace_updated', {
      changed_name: typeof body?.name === 'string',
      changed_system_prompt: typeof body?.system_prompt === 'string',
    });
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
    const workspace = c.get('workspace');
    await workspaceEngine.deleteWorkspace(db, workspace.id);
    emitServerEvent(c, workspace.id, 'relaycast_server_workspace_deleted', {
      deleted_via: 'api',
    });
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
    emitServerEvent(c, workspace.id, 'relaycast_server_agent_token_rotated', {
      agent_name: c.req.param('name'),
    });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /workspace/stream - get workspace stream effective config
workspaceRoutes.get('/workspace/stream', requireWorkspaceKey, rateLimit, async (c) => {
  const logger = getRequestLogger(c, 'workspace.stream.get');
  const workspaceId = c.get('workspace').id;
  try {
    const config = await getWorkspaceStreamConfig(c.env, workspaceId);
    return c.json({
      ok: true,
      data: {
        enabled: config.enabled,
        default_enabled: config.defaultEnabled,
        override: config.override,
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    logger.error('Failed to get stream config', {
      workspaceId,
      code: error.code,
      status: error.status,
      ...toErrorDetails(error),
    });
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// PUT /workspace/stream - set workspace stream override
workspaceRoutes.put('/workspace/stream', requireWorkspaceKey, rateLimit, async (c) => {
  const logger = getRequestLogger(c, 'workspace.stream.put');
  const workspaceId = c.get('workspace').id;
  try {
    const parsed = updateWorkspaceStreamSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'Provide { enabled: boolean } or { mode: "inherit" }' },
      }, 400);
    }
    const body = parsed.data;

    let override: boolean | null;
    if (body?.mode === 'inherit') {
      override = null;
    } else if (typeof body?.enabled === 'boolean') {
      override = body.enabled;
    } else {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'Provide { enabled: boolean } or { mode: "inherit" }' },
      }, 400);
    }

    await setWorkspaceStreamOverride(c.env, workspaceId, override);
    const config = await getWorkspaceStreamConfig(c.env, workspaceId);
    emitServerEvent(c, workspaceId, 'relaycast_server_workspace_stream_updated', {
      stream_mode: override === null ? 'inherit' : (override ? 'enabled' : 'disabled'),
    });

    return c.json({
      ok: true,
      data: {
        enabled: config.enabled,
        default_enabled: config.defaultEnabled,
        override: config.override,
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    logger.error('Failed to update stream config', {
      workspaceId,
      code: error.code,
      status: error.status,
      ...toErrorDetails(error),
    });
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
