import { isArWorkspaceId, parseCredential } from '@relaycast/types';
import { AR_WORKSPACE_ID_REQUIRED, acceptsOnlyAr, credentialFormat } from '../auth/credentials.js';
import { Hono, type Context } from 'hono';
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
  MAX_WORKSPACE_EXPIRY_SECONDS,
  pushWorkspaceKey,
  setWorkspaceExpiry,
} from '../engine/internalAdmin.js';
import { WORKSPACE_KEY_MAX_GRACE_MS } from '../engine/tokenRotate.js';
import { deriveInternalWorkspaceCreateKey, internalCapabilities } from '../engine/internalCapabilities.js';
import { parseIdempotencyKey } from '../middleware/idempotency.js';

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

/**
 * A single-workspace host (`config.workspaceId`: one workspace per durable
 * actor) holds exactly that workspace. Its control plane creates workspaces
 * by picking the actor, so `POST /internal/workspaces` is not served here,
 * and a workspace-scoped route naming another id is a 404 rather than an
 * action on a workspace this host never held.
 */
function singleWorkspaceId(c: Context<AppEnv>): string | undefined {
  return c.get('engine').config.workspaceId;
}

function foreignWorkspace(c: Context<AppEnv>, workspaceId: string): boolean {
  const own = singleWorkspaceId(c);
  return own !== undefined && own !== workspaceId;
}

// GET /internal/capabilities — non-mutating capability advertisement. A
// single-workspace host creates no workspaces (its gateway does), so it does
// not advertise `create`. `create_idempotency` is advertised only where a
// keyed create works: the create route is served and a workspace bootstrap
// secret is configured.
internalRoutes.get('/capabilities', (c) => {
  const create = singleWorkspaceId(c) === undefined;
  return jsonOk(c, internalCapabilities({
    create,
    createIdempotency: Boolean(c.get('engine').config.workspaceBootstrapSecret),
  }));
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  metadata: WorkspaceMetadataSchema.optional(),
}).strict();

// POST /internal/workspaces — create a workspace and reveal its key once.
// Self-host extension; the hosted control plane creates workspaces implicitly
// through the upsert on /internal/workspaces/:id/api-key.
//
// With an `Idempotency-Key` the create is keyed: the first request creates
// the workspace (201), a replay of the same key and body returns the same
// workspace and key (200) and never creates another, the same key with
// another body is 409 `workspace_create_idempotency_conflict`, and a key whose
// workspace was deleted is 409 `workspace_create_idempotency_terminalized`.
// The internal secret is the authorization boundary, so no bootstrap proof is
// asked of the caller and no length floor applies to its key; the key is
// recorded in a keyspace of its own (`deriveInternalWorkspaceCreateKey`).
// Without a configured bootstrap secret a keyed create is 503
// `workspace_create_idempotency_unavailable` and changes nothing.
internalRoutes.post('/workspaces', async (c) => {
  if (singleWorkspaceId(c) !== undefined) return jsonNotFound(c, 'not_found', 'Route not found');
  try {
    const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
    if (idempotencyError) return jsonError(c, 'invalid_idempotency_key', idempotencyError, 400);
    const parsed = await parseJsonBody(c, createWorkspaceSchema, 'name is required (1-128 characters)');
    if (!parsed.ok) return parsed.response;
    const { name, metadata } = parsed.data;
    let keyed: { bootstrapSecret: string; idempotencyKey: string; requestDigest: string } | undefined;
    if (idempotencyKey !== undefined) {
      const bootstrapSecret = c.get('engine').config.workspaceBootstrapSecret;
      if (!bootstrapSecret) {
        return jsonError(
          c,
          'workspace_create_idempotency_unavailable',
          'Workspace create idempotency is not configured on this deployment',
          503,
        );
      }
      keyed = {
        bootstrapSecret,
        idempotencyKey: await deriveInternalWorkspaceCreateKey(bootstrapSecret, idempotencyKey),
        requestDigest: await workspaceEngine.workspaceCreateRequestDigest({
          name,
          ...(metadata === undefined ? {} : { metadata }),
        }),
      };
    }
    const result = await workspaceEngine.createWorkspace(c.get('db'), name, {
      ...(metadata === undefined ? {} : { metadata }),
      ...(keyed ?? {}),
    });
    if (result.created) emitServerEvent(c, result.workspace.workspace_id, 'workspace.created', {});
    const data = { ...result.workspace, name, api_key_generation: 0 };
    return result.created ? jsonCreated(c, data) : jsonOk(c, data);
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
  if (foreignWorkspace(c, workspaceId)) return jsonNotFound(c, 'not_found', 'Workspace not found');
  const fence = beginInternalWorkspaceDeletion(c.get('db'), workspaceId);
  try {
    await workspaceEngine.deleteWorkspace(c.get('db'), c.get('engine').files, workspaceId);
    fence.commit();
    return c.body(null, 204);
  } catch (err: unknown) {
    fence.release();
    return errorResponse(c, err);
  }
});

const pushKeySchema = z.object({
  // `rk_live_` + 32..256 URL-safe characters: the engine mints 32 hex chars and
  // the cloud control plane mints base64url(32 bytes), so `-`/`_` are allowed.
  // Not trimmed: the stored hash must match the exact bearer callers send,
  // so surrounding whitespace is refused by the pattern instead.
  // Or an `ar_ws_` workspace key naming this workspace (checked below).
  api_key: z.string().refine(
    (key) => WORKSPACE_KEY_PATTERN.test(key) || parseCredential(key)?.kind === 'workspace' && parseCredential(key)?.family === 'ar',
    'api_key must be an rk_live_ workspace key (rk_live_ followed by 32-256 characters of [A-Za-z0-9_-]) or an ar_ws_ workspace key',
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
    if (foreignWorkspace(c, workspaceId)) return jsonNotFound(c, 'not_found', 'Workspace not found');
    // A deployment that mints ar_ credentials carries the workspace in each
    // one as a 64-bit snowflake, so it registers no other ids.
    if (credentialFormat(c.get('db')) === 'ar' && !isArWorkspaceId(workspaceId)) {
      return jsonError(c, 'invalid_request', AR_WORKSPACE_ID_REQUIRED, 400);
    }
    const parsed = await parseOptionalJsonBody(c, pushKeySchema, (result) =>
      result.error.issues[0]?.message ?? 'Invalid key push body');
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (body.api_key !== undefined) {
      const key = parseCredential(body.api_key);
      if (key?.family === 'ar' && key.workspaceId !== workspaceId) {
        return jsonError(c, 'invalid_request', 'api_key names another workspace', 400);
      }
      // A deployment that accepts only ar_ credentials never holds a legacy key.
      if (key?.family !== 'ar' && acceptsOnlyAr(c.get('db'))) {
        return jsonError(c, 'invalid_request', 'api_key must be an ar_ws_ workspace key on this deployment', 400);
      }
    }
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

const expirySchema = z.object({
  expires_in_seconds: z.number().int()
    .min(60, 'expires_in_seconds must be at least 60')
    .max(MAX_WORKSPACE_EXPIRY_SECONDS, `expires_in_seconds must be at most ${MAX_WORKSPACE_EXPIRY_SECONDS}`)
    .nullable(),
}).strict();

// POST /internal/workspaces/:id/expiry — `{ expires_in_seconds: n }` moves a
// live workspace's deadline to n seconds from now (a temporary workspace kept
// alive by activity); `null` clears it (the workspace was claimed). A workspace
// already past its deadline is not revived: 409 workspace_expired.
// → `{ workspace_id, expires_at }`.
internalRoutes.post('/workspaces/:id/expiry', async (c) => {
  try {
    const workspaceId = c.req.param('id');
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      return jsonError(c, 'invalid_request', 'Invalid workspace id', 400);
    }
    if (foreignWorkspace(c, workspaceId)) return jsonNotFound(c, 'not_found', 'Workspace not found');
    const parsed = await parseJsonBody(c, expirySchema, 'expires_in_seconds is required (seconds, or null to clear)');
    if (!parsed.ok) return parsed.response;
    const seconds = parsed.data.expires_in_seconds;
    const now = new Date();
    const result = await setWorkspaceExpiry(
      c.get('db'),
      workspaceId,
      seconds === null ? null : new Date(now.getTime() + seconds * 1000),
      now,
    );
    if (!result.ok) {
      return result.reason === 'expired'
        ? jsonError(c, 'workspace_expired', 'Workspace has expired', 409)
        : jsonNotFound(c, 'not_found', 'Workspace not found');
    }
    return jsonOk(c, { workspace_id: result.workspaceId, expires_at: result.expiresAt?.toISOString() ?? null });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
