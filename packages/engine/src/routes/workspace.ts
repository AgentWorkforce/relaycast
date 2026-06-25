import { Hono } from 'hono';
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
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonError,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseQueryParams,
} from '../lib/httpResponse.js';
import { parsePaginationQuery, positiveIntQueryParam } from '../lib/httpQuery.js';

export const workspaceRoutes = new Hono<AppEnv>();

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
});

const updateWorkspaceSchema = z.object({
  name: z.string().optional(),
  system_prompt: z.string().nullable().optional(),
});

const activityQuerySchema = z.object({
  limit: positiveIntQueryParam({ defaultValue: 20, max: 500 }),
});

function workspaceNotFound(c: Context<AppEnv>) {
  return jsonNotFound(c, 'workspace_not_found', 'Workspace not found');
}

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
  const bucketKey = `public-workspace-lookup:${clientId}:${window}`;

  try {
    const { count, allowed } = await c.get('engine').rateLimiter.check({
      bucketKey,
      limit,
      windowMs: 60_000,
    });
    const remaining = Math.max(0, limit - count);

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      return jsonError(c, 'rate_limit_exceeded', `Rate limit exceeded. ${limit} requests per minute allowed for public workspace lookups.`, 429);
    }
  } catch {
    const { allowed, remaining } = inMemoryPublicLookupRateCheck(clientId, limit);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      return jsonError(c, 'rate_limit_exceeded', `Rate limit exceeded. ${limit} requests per minute allowed for public workspace lookups.`, 429);
    }
  }

  await next();
});

// POST /workspaces - create workspace (no auth required, workspace key optional)
workspaceRoutes.post('/workspaces', async (c) => {
  try {
    const parsed = await parseJsonBody(c, createWorkspaceSchema, 'name is required');
    if (!parsed.ok) {
      return parsed.response;
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
    return result.created ? jsonCreated(c, result.workspace) : jsonOk(c, result.workspace);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /workspaces/by-name/:name - lookup public workspace metadata by name
workspaceRoutes.get('/workspaces/by-name/:name', publicWorkspaceLookupRateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = await workspaceEngine.getWorkspaceByName(db, c.req.param('name'));
    if (!workspace) {
      return workspaceNotFound(c);
    }
    return jsonOk(c, workspace);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /workspace - get current workspace
workspaceRoutes.get('/workspace', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = await workspaceEngine.getWorkspace(db, c.get('workspace').id);
    if (!workspace) {
      return workspaceNotFound(c);
    }
    return jsonOk(c, workspace);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// PATCH /workspace - update workspace
workspaceRoutes.patch('/workspace', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, updateWorkspaceSchema, 'invalid workspace update body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const body = parsed.data;
    const updated = await workspaceEngine.updateWorkspace(db, workspace.id, body);
    if (!updated) {
      return workspaceNotFound(c);
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_workspace_updated', {
      changed_name: typeof body?.name === 'string',
      changed_system_prompt: typeof body?.system_prompt === 'string',
    });
    return jsonOk(c, updated);
  } catch (err: unknown) {
    return errorResponse(c, err);
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
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /activity — recent activity feed
workspaceRoutes.get('/activity', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = parseQueryParams(c, activityQuerySchema, 'Invalid activity query');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { limit } = parsed.data;

    const items = await activityEngine.getActivityFeed(db, workspace.id, limit);
    return jsonOk(c, items);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /dm/conversations/all — workspace-wide DM list
workspaceRoutes.get('/dm/conversations/all', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const conversations = await dmAllEngine.listAllDmConversations(db, workspace.id);
    return jsonOk(c, conversations);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /dm/conversations/:conversation_id/messages — DM messages by conversation
workspaceRoutes.get('/dm/conversations/:conversation_id/messages', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const conversationId = c.req.param('conversation_id');
    const query = parsePaginationQuery(c);
    if (!query.ok) {
      return query.response;
    }
    const { limit, before, after } = query.data;

    const msgs = await dmAllEngine.getDmMessagesForWorkspace(
      db, workspace.id, conversationId, { limit, before, after },
    );
    return jsonOk(c, msgs);
  } catch (err: unknown) {
    return errorResponse(c, err);
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
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
