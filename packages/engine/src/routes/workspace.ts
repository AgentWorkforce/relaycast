import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { WorkspaceProvenanceInputSchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { requireAgentToken, requireWorkspaceKey, requireWorkspaceRead } from '../middleware/auth.js';
import { parseIdempotencyKey } from '../middleware/idempotency.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as workspaceEngine from '../engine/workspace.js';
import * as activityEngine from '../engine/activity.js';
import * as dmAllEngine from '../engine/dmAll.js';
import * as tokenRotateEngine from '../engine/tokenRotate.js';
import {
  filterObserverSearchResults,
  getObserverTokenFromContext,
  observerAllowsConversation,
  observerAllowsEvent,
  observerAllowsMessage,
  OBSERVER_SCOPES,
} from '../engine/observerToken.js';
import {
  listWorkspaceEvents,
  WORKSPACE_EVENT_LIST_DEFAULT_LIMIT,
  WORKSPACE_EVENT_LIST_MAX_LIMIT,
  type WorkspaceEventRecord,
} from '../engine/workspaceEvents.js';
import { channels, type WorkspaceProvenanceRecord } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { asCodedError, errorResponse, safeErrorDiagnostics } from '../lib/httpError.js';
import { getRequestLogger } from '../lib/logger.js';
import { buildWorkspaceProvenance } from '../lib/workspaceProvenance.js';
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
import { runInBackground } from './background.js';

export const workspaceRoutes = new Hono<AppEnv>();

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  expires_in_seconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
  provenance: WorkspaceProvenanceInputSchema.optional(),
});

const updateWorkspaceSchema = z.object({
  name: z.string().optional(),
  system_prompt: z.string().nullable().optional(),
});

const activityQuerySchema = z.object({
  limit: positiveIntQueryParam({ defaultValue: 20, max: 500 }),
});

const workspaceEventsQuerySchema = z.object({
  since: z.preprocess(
    (value) => {
      if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
        return undefined;
      }
      return Number(value);
    },
    z.number().int().min(0).default(0),
  ),
  limit: positiveIntQueryParam({
    defaultValue: WORKSPACE_EVENT_LIST_DEFAULT_LIMIT,
    max: WORKSPACE_EVENT_LIST_MAX_LIMIT,
  }),
});

function workspaceNotFound(c: Context<AppEnv>) {
  return jsonNotFound(c, 'workspace_not_found', 'Workspace not found');
}

function redactProvenanceForObserver(
  provenance: WorkspaceProvenanceRecord | null,
): WorkspaceProvenanceRecord | null {
  if (!provenance) return null;
  return {
    source: provenance.source,
    ...(provenance.origin_id ? { origin_id: provenance.origin_id } : {}),
    classification: provenance.classification,
    source_basis: provenance.source_basis,
  };
}

async function deleteAuthenticatedWorkspace(c: Context<AppEnv>, expectedId?: string) {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    if (expectedId !== undefined && expectedId !== workspace.id) {
      return workspaceNotFound(c);
    }
    await workspaceEngine.deleteWorkspace(db, c.get('engine').files, workspace.id);
    emitServerEvent(c, workspace.id, 'relaycast_server_workspace_deleted', {
      deleted_via: 'api',
    });
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
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
    const {
      name,
      expires_in_seconds: expiresInSeconds,
      provenance: declaredProvenance,
    } = parsed.data;
    const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
    if (idempotencyError) {
      return jsonError(c, 'invalid_idempotency_key', idempotencyError, 400);
    }
    const db = c.get('db');
    const ownerApiKey = extractOwnerApiKey(c.req.header('Authorization'));
    if (idempotencyKey) {
      if (!ownerApiKey) {
        return jsonError(c, 'workspace_create_idempotency_owner_required', 'An authenticated workspace owner is required when Idempotency-Key is supplied', 401);
      }
      const ownerAuth = await c.get('engine').auth.authenticate({ token: ownerApiKey, require: 'workspace', db });
      if (!ownerAuth.ok) {
        return jsonError(c, ownerAuth.code, ownerAuth.message, ownerAuth.status as ContentfulStatusCode);
      }
    }
    const requestDigest = idempotencyKey
      ? await workspaceEngine.workspaceCreateRequestDigest({
        name,
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        ...(declaredProvenance === undefined ? {} : { provenance: declaredProvenance }),
      })
      : undefined;
    const attribution = buildWorkspaceProvenance(c.req.raw, declaredProvenance);
    const result = await workspaceEngine.createWorkspace(
      db,
      name,
      {
        ...(ownerApiKey ? { ownerApiKey } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(requestDigest ? { requestDigest } : {}),
        ...(expiresInSeconds
          ? { expiresAt: new Date(Date.now() + expiresInSeconds * 1_000) }
          : {}),
        ...attribution,
      },
    );
    if (result.created) {
      emitServerEvent(c, result.workspace.workspace_id, 'relaycast_server_workspace_created', {
        created_via: 'api',
      });
    }
    if (result.created) {
      runInBackground(
        c,
        workspaceEngine.reapExpiredWorkspaces(db, c.get('engine').files),
        'workspace expiry reap',
      );
    }
    return result.created ? jsonCreated(c, result.workspace) : jsonOk(c, result.workspace);
  } catch (err: unknown) {
    const error = asCodedError(err);
    if ((error.status ?? 500) >= 500) {
      const diagnostics = safeErrorDiagnostics(error);
      getRequestLogger(c, 'workspace.create').error('Workspace creation failed', {
        error_code: error.code ?? 'internal_error',
        error_status: error.status ?? 500,
        ...diagnostics,
      });
      c.get('engine').telemetry.captureException(
        new Error(error.code ?? 'internal_error'),
        {
          path: c.req.path,
          method: c.req.method,
          status_code: error.status ?? 500,
          error_code: error.code ?? 'internal_error',
          request_id: c.get('requestId'),
          ...diagnostics,
        },
      );
    }
    return errorResponse(c, err);
  }
});

// DELETE /workspaces/:id - delete the authenticated workspace by explicit id
workspaceRoutes.delete('/workspaces/:id', requireWorkspaceKey, rateLimit, async (c) => {
  return deleteAuthenticatedWorkspace(c, c.req.param('id'));
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

// GET /workspace - get current workspace metadata plus the live effective
// message-retention boundary (no payload or raw retention config) — accepts an observer token
// (any scope; this endpoint predates per-scope enforcement and there's no
// narrower scope that fits "read workspace metadata") in addition to a
// workspace key, so `selectEngineForKey`-style credential probes succeed for
// observer-token logins, not just full workspace keys. Agent/node tokens are
// still rejected, matching prior behavior.
workspaceRoutes.get(
  '/workspace',
  requireWorkspaceRead([...OBSERVER_SCOPES], { allowAgent: false, allowNode: false }),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = await workspaceEngine.getWorkspace(
        db,
        c.get('workspace').id,
        c.get('engine').config.retention?.messageTtlDays,
      );
      if (!workspace) {
        return workspaceNotFound(c);
      }
      const observer = getObserverTokenFromContext(c);
      return jsonOk(c, observer
        ? { ...workspace, provenance: redactProvenanceForObserver(workspace.provenance) }
        : workspace);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

/**
 * Observer scoping for the durable event log, kept in lockstep with the live
 * stream: each row is checked with the same `observerAllowsEvent` the realtime
 * adapters apply per frame, so a scoped token can never read via backfill what
 * it would not have seen live (per-event-type scopes, `event_types`,
 * `created_after`, channel and DM filters). Channel names are looked up so
 * `channel_names` filters apply; rows without channel or conversation context
 * pass the channel leg but still face the scope checks.
 */
async function filterObserverWorkspaceEvents(
  c: Context<AppEnv>,
  workspaceId: string,
  events: WorkspaceEventRecord[],
): Promise<WorkspaceEventRecord[]> {
  const observer = getObserverTokenFromContext(c);
  if (!observer || events.length === 0) return events;

  const channelIds = [...new Set(events.flatMap((event) => (event.channel_id ? [event.channel_id] : [])))];
  const channelsById = new Map<string, { name: string; channel_type: number }>();
  if (channelIds.length > 0) {
    const rows = await c.get('db')
      .select({ id: channels.id, name: channels.name, channel_type: channels.channelType })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, channelIds)));
    for (const row of rows) channelsById.set(row.id, { name: row.name, channel_type: row.channel_type });
  }

  return events.filter((event) => {
    const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
    const channel = event.channel_id ? channelsById.get(event.channel_id) : undefined;
    return observerAllowsEvent(observer, {
      ...payload,
      type: event.type,
      ...(event.channel_id ? { channel_id: event.channel_id } : {}),
      ...(channel?.name && typeof payload.channel !== 'string' ? { channel: channel.name } : {}),
    });
  });
}

// GET /workspace/events — durable, cursor-based workspace event log
workspaceRoutes.get(
  '/workspace/events',
  requireWorkspaceRead('stream:read', { allowAgent: false, allowNode: false }),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = parseQueryParams(c, workspaceEventsQuerySchema, 'Invalid workspace events query');
      if (!parsed.ok) {
        return parsed.response;
      }
      const since = parsed.data.since;
      const limit = parsed.data.limit ?? WORKSPACE_EVENT_LIST_DEFAULT_LIMIT;

      // Scoped observer tokens can hide most of a raw page, so keep scanning
      // forward (bounded) until `limit` visible rows are collected or the log
      // is exhausted. `next_since` is the resume cursor: the seq of the last
      // row the scan CONSUMED (visible or hidden) — clients advance by it so
      // an all-hidden window can never stall pagination, and no visible row
      // beyond the returned page is ever skipped.
      const SCAN_CAP_ROWS = 2_000;
      const visible: Awaited<ReturnType<typeof listWorkspaceEvents>>['events'] = [];
      let cursor = since;
      let latestSeq = 0;
      let scanned = 0;
      while (visible.length < limit && scanned < SCAN_CAP_ROWS) {
        const page = await listWorkspaceEvents(db, workspace.id, { since: cursor, limit });
        latestSeq = page.latestSeq;
        if (page.events.length === 0) break;
        scanned += page.events.length;
        const allowed = await filterObserverWorkspaceEvents(c, workspace.id, page.events);
        for (const event of allowed) {
          if (visible.length >= limit) break;
          visible.push(event);
        }
        cursor = visible.length >= limit
          ? visible[visible.length - 1].seq
          : page.events[page.events.length - 1].seq;
        if (visible.length >= limit || cursor >= page.latestSeq) break;
      }
      return jsonOk(c, { events: visible, latest_seq: latestSeq, next_since: cursor });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

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
    const updated = await workspaceEngine.updateWorkspace(
      db,
      workspace.id,
      body,
      c.get('engine').config.retention?.messageTtlDays,
    );
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
  return deleteAuthenticatedWorkspace(c);
});

// GET /activity — recent activity feed
workspaceRoutes.get('/activity', requireWorkspaceRead('activity:read', { allowAgent: false, allowNode: false }), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = parseQueryParams(c, activityQuerySchema, 'Invalid activity query');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { limit } = parsed.data;

    const items = await activityEngine.getActivityFeed(db, workspace.id, limit);
    const visibleItems = await filterObserverSearchResults(
      db,
      workspace.id,
      getObserverTokenFromContext(c),
      items,
      {
        eventTypes: (item) => (item.conversation_id
          ? ['dm.received', 'group_dm.received']
          : ['message.created']),
      },
    );
    const responseItems = visibleItems.map(({ channel_type: _channelType, ...item }) => item);
    return jsonOk(c, responseItems);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /dm/conversations/all — workspace-wide DM list
workspaceRoutes.get('/dm/conversations/all', requireWorkspaceRead('dms:read', { allowAgent: false, allowNode: false }), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const observer = getObserverTokenFromContext(c);
    const conversations = (await dmAllEngine.listAllDmConversations(db, workspace.id))
      .filter((conversation) =>
        observerAllowsConversation(observer, conversation.id)
        && (!conversation.last_message || observerAllowsMessage(observer, conversation.last_message)));
    return jsonOk(c, conversations);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /dm/conversations/:conversation_id/messages — DM messages by conversation
workspaceRoutes.get('/dm/conversations/:conversation_id/messages', requireWorkspaceRead('dms:read', { allowAgent: false, allowNode: false }), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const conversationId = c.req.param('conversation_id');
    if (!observerAllowsConversation(getObserverTokenFromContext(c), conversationId)) {
      return jsonNotFound(c, 'dm_conversation_not_found', 'Conversation not found');
    }
    const query = parsePaginationQuery(c);
    if (!query.ok) {
      return query.response;
    }
    const { limit, before, after } = query.data;

    const msgs = await dmAllEngine.getDmMessagesForWorkspace(
      db, workspace.id, conversationId, { limit, before, after },
    );
    return jsonOk(c, msgs.filter((message) => observerAllowsMessage(getObserverTokenFromContext(c), message)));
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /agents/:name/rotate-token — authenticated self-rollover only. Workspace
// owners use the explicit, audited /takeover or /revoke-token operations.
workspaceRoutes.post('/agents/:name/rotate-token', requireAgentToken, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const authAgent = c.get('agent')!;
    if (authAgent.name !== c.req.param('name')) {
      return jsonError(
        c,
        'agent_recovery_not_authorized',
        'An agent token may rotate only its own identity',
        403,
      );
    }
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
