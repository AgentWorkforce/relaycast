import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { WorkspaceMetadataSchema } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { constantTimeEqual } from '../lib/crypto.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonError,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseOptionalJsonBody,
} from '../lib/httpResponse.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import * as workspaceEngine from '../engine/workspace.js';
import {
  beginInternalWorkspaceDeletion,
  INTERNAL_CAPABILITIES,
  pushWorkspaceKey,
} from '../engine/internalAdmin.js';
import { WORKSPACE_KEY_MAX_GRACE_MS } from '../engine/tokenRotate.js';

/**
 * Internal admin API for a trusted control plane (self-host).
 *
 * Mounted at `/internal`. Enabled only when `config.internalSecret` is set
 * (RELAYCAST_INTERNAL_SECRET); otherwise every route answers the generic 404
 * so the surface is indistinguishable from an engine that has none. Callers
 * authenticate with `Authorization: Bearer <secret>`, compared in constant
 * time. Request and response shapes match the hosted gateway's
 * `/internal/capabilities` and `/internal/workspaces/:id/api-key`.
 */
export const internalRoutes = new Hono<AppEnv>();

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_KEY_PATTERN = /^rk_live_[A-Za-z0-9_-]{32,256}$/;

const requireInternalSecret = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.get('engine').config.internalSecret;
  if (!expected) {
    return jsonNotFound(c, 'not_found', 'Route not found');
  }
  const header = c.req.header('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!(await constantTimeEqual(presented, expected))) {
    return jsonError(c, 'unauthorized', 'Invalid internal token', 401);
  }
  await next();
});

internalRoutes.use('*', requireInternalSecret);

// GET /internal/capabilities — non-mutating capability advertisement.
internalRoutes.get('/capabilities', (c) => jsonOk(c, INTERNAL_CAPABILITIES));

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  metadata: WorkspaceMetadataSchema.optional(),
}).strict();

// POST /internal/workspaces — create a workspace and reveal its key once.
// Self-host extension; the hosted control plane creates workspaces implicitly
// through the upsert on /internal/workspaces/:id/api-key.
internalRoutes.post('/workspaces', async (c) => {
  try {
    const parsed = await parseJsonBody(c, createWorkspaceSchema, 'name is required (1-128 characters)');
    if (!parsed.ok) return parsed.response;
    const result = await workspaceEngine.createWorkspace(c.get('db'), parsed.data.name, {
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    });
    emitServerEvent(c, result.workspace.workspace_id, 'workspace.created', {});
    return jsonCreated(c, {
      ...result.workspace,
      name: parsed.data.name,
      api_key_generation: 0,
    });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /internal/workspaces/:id — authoritative, idempotent deletion for a
// trusted control plane. Unlike the public route this authenticates with the
// internal secret, so a retry remains distinguishable from a wrong workspace
// key after the workspace row (and its key hash) is already gone.
internalRoutes.delete('/workspaces/:id', async (c) => {
  const workspaceId = c.req.param('id');
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return jsonError(c, 'invalid_request', 'Invalid workspace id', 400);
  }
  const releaseFence = beginInternalWorkspaceDeletion(c.get('db'), workspaceId);
  try {
    await workspaceEngine.deleteWorkspace(c.get('db'), c.get('engine').files, workspaceId);
    return c.body(null, 204);
  } catch (err: unknown) {
    releaseFence();
    return errorResponse(c, err);
  }
});

const pushKeySchema = z.object({
  // `rk_live_` + 32..256 URL-safe characters: the engine mints 32 hex chars and
  // the cloud control plane mints base64url(32 bytes), so `-`/`_` are allowed.
  api_key: z.string().trim().regex(
    WORKSPACE_KEY_PATTERN,
    'api_key must be an rk_live_ workspace key (rk_live_ followed by 32-256 characters of [A-Za-z0-9_-])',
  ).optional(),
  // Accepted for wire compatibility with the hosted gateway; the self-host
  // engine has no plan entitlements, so the value is validated and ignored.
  plan: z.string().min(1).optional(),
  key_generation: z.number().int()
    .min(1, 'key_generation must be a positive integer')
    .max(Number.MAX_SAFE_INTEGER, 'key_generation must be a safe integer')
    .optional(),
  grace_ms: z.number().int().min(0).max(WORKSPACE_KEY_MAX_GRACE_MS).optional(),
}).refine((body) => body.grace_ms === undefined || body.key_generation !== undefined || body.api_key === undefined, {
  message: 'grace_ms requires key_generation',
});

// POST /internal/workspaces/:id/api-key — register (upsert) or rotate a
// workspace key. Hosted shape: body `{ api_key, key_generation?, grace_ms?,
// plan? }` → `{ workspace_id, api_key_generation }` (201 when the push created
// the workspace). Self-host extension: omit `api_key` and the engine mints the
// replacement, returned once as `api_key`.
internalRoutes.post('/workspaces/:id/api-key', async (c) => {
  try {
    const workspaceId = c.req.param('id');
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      return jsonError(c, 'invalid_request', 'Invalid workspace id', 400);
    }
    const parsed = await parseOptionalJsonBody(c, pushKeySchema, (result) =>
      result.error.issues[0]?.message ?? 'Invalid key push body');
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const result = await pushWorkspaceKey(c.get('db'), workspaceId, {
      ...(body.api_key === undefined ? {} : { apiKey: body.api_key }),
      ...(body.key_generation === undefined ? {} : { keyGeneration: body.key_generation }),
      ...(body.grace_ms === undefined ? {} : { graceMs: body.grace_ms }),
    });
    if (result.mintedApiKey) {
      emitServerEvent(c, workspaceId, 'workspace.key.rotated', {
        grace_seconds: Math.floor((body.grace_ms ?? 0) / 1000),
      });
    }
    const data = {
      workspace_id: result.workspaceId,
      api_key_generation: result.apiKeyGeneration,
      ...(result.mintedApiKey ? { api_key: result.mintedApiKey } : {}),
    };
    return result.created ? jsonCreated(c, data) : jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
