/**
 * `/internal/*`: the admin API a trusted control plane calls (self-host).
 *
 * Enabled only when `RELAYCAST_INTERNAL_SECRET` is set; otherwise every route
 * answers the generic 404 so the surface is indistinguishable from a gateway
 * that has none. Callers authenticate with `Authorization: Bearer <secret>`,
 * compared in constant time. The gateway owns the routes a workspace id does
 * not yet exist for (create: it mints the id and tag); the rest go to that
 * workspace's actor, which validates the same secret itself.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { generateWorkspaceId } from '@relaycast/engine/gateway';
import { WorkspaceMetadataSchema, isArWorkspaceId } from '@relaycast/types';
import type { GatewayContext } from './context.js';
import { REQUEST_ID_HEADER, bearerToken, readBody, sendActorResponse, sendError, sendJson, toActorRequest } from './http.js';

/** Mirrors `INTERNAL_CAPABILITIES` in the engine (packages/engine/src/engine/internalAdmin.ts). */
export const INTERNAL_CAPABILITIES = {
  workspace_key_push: {
    generation_cas: true,
    generation_required_once_fenced: true,
    grace_ms: true,
    max_grace_ms: 3_600_000,
    revocation_markers: true,
    previous_key_slot: true,
  },
  workspace_admin: {
    create: true,
    delete: true,
    server_minted_key: true,
  },
} as const;

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_ROUTE = /^\/internal\/workspaces\/([^/]+)(\/api-key)?$/;
/** Admin bodies are small; this is not the upload cap. */
const MAX_INTERNAL_BODY_BYTES = 64 * 1024;

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  metadata: WorkspaceMetadataSchema.optional(),
}).strict();

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export interface InternalRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requestId: string;
  signal: AbortSignal;
  /** Reports the workspace the request turned out to concern, for the access log. */
  setWorkspace: (workspaceId: string) => void;
}

/** Serve one `/internal/*` request. Actor failures propagate to the caller's 502 handling. */
export async function handleInternal(ctx: GatewayContext, { req, res, url, requestId, signal, setWorkspace }: InternalRequest): Promise<void> {
  const expected = ctx.config.internalSecret;
  if (!expected) return sendError(res, 404, 'not_found', 'Route not found');
  const presented = bearerToken(req) ?? '';
  if (!constantTimeEqual(presented, expected)) return sendError(res, 401, 'unauthorized', 'Invalid internal token');

  const path = url.pathname;
  if (req.method === 'GET' && path === '/internal/capabilities') {
    return sendJson(res, 200, { ok: true, data: INTERNAL_CAPABILITIES });
  }

  if (req.method === 'POST' && path === '/internal/workspaces') {
    const raw = await readBody(req, MAX_INTERNAL_BODY_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendError(res, 400, 'invalid_json', 'Malformed JSON in request body');
    }
    const parsed = createWorkspaceSchema.safeParse(json);
    if (!parsed.success) return sendError(res, 400, 'invalid_request', 'name is required (1-128 characters)');
    // The gateway mints the id and its routing tag, exactly as the public
    // create does, and the actor creates the workspace from a synthesized
    // `POST /v1/workspaces`; its 201 and body (the workspace and its key,
    // revealed once) answer this call.
    const workspaceId = generateWorkspaceId();
    setWorkspace(workspaceId);
    const tag = await ctx.credentialTags.tag(workspaceId);
    const body = JSON.stringify({
      name: parsed.data.name,
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    });
    const response = await ctx.actors.create(workspaceId, {
      method: 'POST',
      url: `${url.origin}/v1/workspaces`,
      headers: [['host', url.host], ['content-type', 'application/json'], [REQUEST_ID_HEADER, requestId]],
      body,
    }, tag, { signal });
    return sendActorResponse(res, response);
  }

  const match = WORKSPACE_ROUTE.exec(path);
  if (match) {
    const workspaceId = decodeURIComponent(match[1]);
    const isDelete = req.method === 'DELETE' && match[2] === undefined;
    const isKeyPush = req.method === 'POST' && match[2] !== undefined;
    if (isDelete || isKeyPush) {
      if (!WORKSPACE_ID_PATTERN.test(workspaceId)) return sendError(res, 400, 'invalid_request', 'Invalid workspace id');
      // A workspace actor's id is a 64-bit snowflake (the engine refuses any
      // other), so no actor is spawned for a malformed id.
      if (!isArWorkspaceId(workspaceId)) {
        return sendError(res, 400, 'invalid_request', 'Workspace ids on this deployment are 64-bit snowflakes');
      }
      setWorkspace(workspaceId);
      const body = req.method === 'POST' ? await readBody(req, MAX_INTERNAL_BODY_BYTES) : null;
      // The Authorization header travels with the request: the actor checks the same secret.
      const response = await ctx.actors.handle(workspaceId, toActorRequest(req, url, body, requestId), { signal });
      return sendActorResponse(res, response);
    }
  }

  return sendError(res, 404, 'not_found', 'Route not found');
}
