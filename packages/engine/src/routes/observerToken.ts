import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';
import {
  OBSERVER_SCOPES,
  createObserverToken,
  getObserverToken,
  listObserverTokens,
  revokeObserverToken,
  rotateObserverToken,
  updateObserverToken,
} from '../engine/observerToken.js';

export const observerTokenRoutes = new Hono<AppEnv>();

const isoTimestamp = z.string().datetime({ message: 'expires_at must be an ISO-8601 timestamp' });

const observerScopeSchema = z.enum(OBSERVER_SCOPES);

const observerFiltersSchema = z.object({
  channel_ids: z.array(z.string().min(1)).optional(),
  channel_names: z.array(z.string().min(1)).optional(),
  include_dms: z.boolean().optional(),
  dm_conversation_ids: z.array(z.string().min(1)).optional(),
  agent_ids: z.array(z.string().min(1)).optional(),
  event_types: z.array(z.string().min(1)).optional(),
  created_after: isoTimestamp.optional(),
}).strict();

const createObserverTokenSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  scopes: z.array(observerScopeSchema).min(1),
  filters: observerFiltersSchema.optional(),
  expires_at: isoTimestamp.nullable().optional(),
});

const updateObserverTokenSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  scopes: z.array(observerScopeSchema).min(1).optional(),
  filters: observerFiltersSchema.optional(),
  expires_at: isoTimestamp.nullable().optional(),
});

function observerTokenNotFound(c: Parameters<typeof jsonNotFound>[0]) {
  return jsonNotFound(c, 'observer_token_not_found', 'Observer token not found');
}

observerTokenRoutes.post('/observer-tokens', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, createObserverTokenSchema, 'invalid observer token body');
    if (!parsed.ok) return parsed.response;
    const result = await createObserverToken(c.get('db'), c.get('workspace').id, parsed.data);
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

observerTokenRoutes.get('/observer-tokens', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const result = await listObserverTokens(c.get('db'), c.get('workspace').id);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

observerTokenRoutes.get('/observer-tokens/:id', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const result = await getObserverToken(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!result) return observerTokenNotFound(c);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

observerTokenRoutes.patch('/observer-tokens/:id', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, updateObserverTokenSchema, 'invalid observer token update body');
    if (!parsed.ok) return parsed.response;
    const result = await updateObserverToken(c.get('db'), c.get('workspace').id, c.req.param('id'), parsed.data);
    if (!result) return observerTokenNotFound(c);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

observerTokenRoutes.post('/observer-tokens/:id/rotate', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const result = await rotateObserverToken(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!result) return observerTokenNotFound(c);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

observerTokenRoutes.delete('/observer-tokens/:id', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const revoked = await revokeObserverToken(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!revoked) return observerTokenNotFound(c);
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
