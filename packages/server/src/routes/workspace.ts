import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
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

const PUBLIC_WORKSPACE_LOOKUP_LIMIT = 30;
const publicWorkspaceLookupBuckets = new Map<string, { count: number; lastSeen: number }>();
let lastPublicWorkspaceLookupCleanup = Date.now();

function getPublicLookupClientId(c: Context<AppEnv>) {
  const forwardedFor = c.req.header('X-Forwarded-For');
  const clientIp = c.req.header('CF-Connecting-IP')
    ?? forwardedFor?.split(',')[0]?.trim()
    ?? 'unknown';
  return clientIp;
}

function inMemoryPublicLookupRateCheck(clientId: string, limit: number) {
  const now = Date.now();

  if (now - lastPublicWorkspaceLookupCleanup > 60_000) {
    lastPublicWorkspaceLookupCleanup = now;
    for (const [key, bucket] of publicWorkspaceLookupBuckets) {
      if (now - bucket.lastSeen > 120_000) {
        publicWorkspaceLookupBuckets.delete(key);
      }
    }
  }

  const window = Math.floor(now / 60_000);
  const bucketKey = `${clientId}:${window}`;
  const bucket = publicWorkspaceLookupBuckets.get(bucketKey) ?? { count: 0, lastSeen: now };
  bucket.count += 1;
  bucket.lastSeen = now;
  publicWorkspaceLookupBuckets.set(bucketKey, bucket);

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
  };
}

function extractOwnerApiKey(authHeader: string | undefined) {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice(7);
  return token.startsWith('rk_') ? token : undefined;
}

const publicWorkspaceLookupRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const clientId = getPublicLookupClientId(c);
  const limit = PUBLIC_WORKSPACE_LOOKUP_LIMIT;
  const window = Math.floor(Date.now() / 60_000);
  const bucketKey = `GET:/workspaces/by-name:${window}`;

  try {
    const id = c.env.RATE_LIMIT_DO.idFromName(`public-workspace-lookup:${clientId}`);
    const stub = c.env.RATE_LIMIT_DO.get(id);
    const res = await stub.fetch(new Request('http://do/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucketKey,
        limit,
        windowMs: 60_000,
      }),
    }));

    if (!res.ok) {
      throw new Error(`RateLimitDO returned HTTP ${res.status}`);
    }

    const payload = await res.json() as {
      ok?: boolean;
      data?: {
        count?: number;
        remaining?: number;
        allowed?: boolean;
      };
    };

    const count = payload.data?.count ?? 1;
    const remaining = payload.data?.remaining ?? Math.max(0, limit - count);
    const allowed = payload.data?.allowed ?? count <= limit;

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      return c.json({
        ok: false,
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. ${limit} requests per minute allowed for public workspace lookups.`,
        },
      }, 429);
    }
  } catch {
    const { allowed, remaining } = inMemoryPublicLookupRateCheck(clientId, limit);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      return c.json({
        ok: false,
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. ${limit} requests per minute allowed for public workspace lookups.`,
        },
      }, 429);
    }
  }

  await next();
});

// POST /workspaces - create workspace (no auth required, workspace key optional)
workspaceRoutes.post('/workspaces', async (c) => {
  try {
    const parsed = createWorkspaceSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'name is required' } }, 400);
    }
    const { name } = parsed.data;
    const db = c.get('db');
    const ownerApiKey = extractOwnerApiKey(c.req.header('Authorization'));
    const result = await workspaceEngine.createWorkspace(
      db,
      name,
      ownerApiKey ? { ownerApiKey } : undefined,
    );
    if (result.created) {
      emitServerEvent(c, result.workspace.workspace_id, 'relaycast_server_workspace_created', {
        created_via: 'api',
      });
    }
    return c.json({ ok: true, data: result.workspace }, result.created ? 201 : 200);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as ContentfulStatusCode);
  }
});

// GET /workspaces/by-name/:name - lookup public workspace metadata by name
workspaceRoutes.get('/workspaces/by-name/:name', publicWorkspaceLookupRateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = await workspaceEngine.getWorkspaceByName(db, c.req.param('name'));
    if (!workspace) {
      return c.json({ ok: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } }, 404);
    }
    return c.json({ ok: true, data: workspace });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as ContentfulStatusCode);
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
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as ContentfulStatusCode);
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
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as ContentfulStatusCode);
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
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as ContentfulStatusCode);
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
    }, (error.status || 500) as ContentfulStatusCode);
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
    }, (error.status || 500) as ContentfulStatusCode);
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
    }, (error.status || 500) as ContentfulStatusCode);
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
    }, (error.status || 500) as ContentfulStatusCode);
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
    }, (error.status || 500) as ContentfulStatusCode);
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
    }, (error.status || 500) as ContentfulStatusCode);
  }
});
