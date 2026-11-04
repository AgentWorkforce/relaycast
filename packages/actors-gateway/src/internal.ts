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
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { INTERNAL_CAPABILITIES, generateWorkspaceId, parseArCredential } from '@relaycast/engine/gateway';
import { WorkspaceMetadataSchema, isArWorkspaceId } from '@relaycast/types';
import type { GatewayContext } from './context.js';
import { REQUEST_ID_HEADER, bearerToken, constantTimeEqual, readBody, sendActorResponse, sendError, sendJson, toActorRequest } from './http.js';
import { BOOTSTRAP_PROOF_HEADER, IDEMPOTENCY_KEY_HEADER, chooseWorkspaceId, isWorkspaceIdTaken } from './workspaceId.js';

/** The engine's own capability document: the actors serve exactly these. */
export { INTERNAL_CAPABILITIES };

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_ROUTE = /^\/internal\/workspaces\/([^/]+)(\/api-key)?$/;
/** Admin bodies are small; this is not the upload cap. */
const MAX_INTERNAL_BODY_BYTES = 64 * 1024;

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  metadata: WorkspaceMetadataSchema.optional(),
}).strict();

/** A path segment percent-decoded, or undefined when the encoding is malformed (a 400, not a 500). */
function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The `api_key` string of a key-push body, when the body is JSON with one; the actor validates the rest. */
function pushedWorkspaceKey(body: Buffer): string | undefined {
  try {
    const json = JSON.parse(body.toString('utf8')) as { api_key?: unknown } | null;
    return typeof json?.api_key === 'string' ? json.api_key : undefined;
  } catch {
    return undefined;
  }
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
    // create does (a keyed create derives the id from its `Idempotency-Key`,
    // which travels to the actor), and the actor creates the workspace from
    // a synthesized `POST /v1/workspaces`; its 201 and body (the workspace
    // and its key, revealed once) answer this call. The internal secret is
    // this call's authentication: like the engine's own internal create, it
    // asks no bootstrap proof of the caller.
    const chosen = await chooseWorkspaceId(req, { bootstrapSecret: ctx.config.workspaceBootstrapSecret });
    if ('error' in chosen) return sendError(res, chosen.error.status, chosen.error.code, chosen.error.message);
    let workspaceId = chosen.workspaceId;
    setWorkspace(workspaceId);
    const body = JSON.stringify({
      name: parsed.data.name,
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    });
    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER];
    // The actor serves the synthesized create on its public route, whose
    // engine asks an anonymous keyed create for proof when the deployment
    // requires it; the gateway holds the same secret and proves it itself.
    const proof = chosen.keyed && ctx.config.workspaceBootstrapProofRequired ? ctx.config.workspaceBootstrapSecret : undefined;
    const request = {
      method: 'POST',
      url: `${url.origin}/v1/workspaces`,
      headers: [
        ['host', url.host],
        ['content-type', 'application/json'],
        [REQUEST_ID_HEADER, requestId],
        ...(typeof idempotencyKey === 'string' ? [[IDEMPOTENCY_KEY_HEADER, idempotencyKey] as [string, string]] : []),
        ...(proof === undefined ? [] : [[BOOTSTRAP_PROOF_HEADER, proof] as [string, string]]),
      ] as [string, string][],
      body,
    };
    let response = await ctx.actors.create(workspaceId, request, await ctx.credentialTags.tag(workspaceId), { signal });
    if (!chosen.keyed && isWorkspaceIdTaken(response)) {
      // Two replicas minted the same snowflake in one millisecond: once more under a fresh one.
      workspaceId = generateWorkspaceId();
      setWorkspace(workspaceId);
      response = await ctx.actors.create(workspaceId, request, await ctx.credentialTags.tag(workspaceId), { signal });
    }
    return sendActorResponse(res, response);
  }

  const match = WORKSPACE_ROUTE.exec(path);
  if (match) {
    const isDelete = req.method === 'DELETE' && match[2] === undefined;
    const isKeyPush = req.method === 'POST' && match[2] !== undefined;
    if (isDelete || isKeyPush) {
      const workspaceId = decodePathSegment(match[1]);
      if (workspaceId === undefined || !WORKSPACE_ID_PATTERN.test(workspaceId)) return sendError(res, 400, 'invalid_request', 'Invalid workspace id');
      // A workspace actor's id is a 64-bit snowflake (the engine refuses any
      // other), so no actor is spawned for a malformed id.
      if (!isArWorkspaceId(workspaceId)) {
        return sendError(res, 400, 'invalid_request', 'Workspace ids on this deployment are 64-bit snowflakes');
      }
      setWorkspace(workspaceId);
      const body = req.method === 'POST' ? await readBody(req, MAX_INTERNAL_BODY_BYTES) : null;
      if (isKeyPush && body) {
        // A pushed `ar_ws_` key becomes the workspace's credential, and the
        // actor keeps its tag as the workspace's routing tag when the push
        // creates the workspace: only a tag this keyring signed may get there,
        // or every later credential the actor mints would be refused here.
        const pushed = pushedWorkspaceKey(body);
        if (pushed !== undefined) {
          const key = parseArCredential(pushed);
          if (key && key.workspaceId === workspaceId && !(await ctx.credentialTags.verify(pushed))) {
            return sendError(res, 400, 'invalid_request', 'api_key carries a routing tag this deployment did not issue');
          }
        }
      }
      // The Authorization header travels with the request: the actor checks the same secret.
      const response = await ctx.actors.handle(workspaceId, toActorRequest(req, url, body, requestId), { signal });
      return sendActorResponse(res, response);
    }
  }

  return sendError(res, 404, 'not_found', 'Route not found');
}
