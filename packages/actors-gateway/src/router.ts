/**
 * Route one HTTP request. The gateway holds no workspace state: an `ar_`
 * credential names its workspace, its tag proves this deployment's keyring
 * tagged that workspace, and that workspace's actor authenticates it against
 * its own tables.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { ACTOR_FILE_ROUTE, generateWorkspaceId, parseArCredential, type ActorHttpRequest, type ActorHttpResponse } from '@relaycast/engine/gateway';
import { ListDeliveriesQuerySchema } from '@relaycast/types';
import { ActorCallError } from './actors.js';
import type { GatewayContext } from './context.js';
import { serveFile } from './files/handler.js';
import {
  BodyTooLarge,
  CLOSE_AFTER,
  REQUEST_ID_HEADER,
  bearerToken,
  readBody,
  requestIdFor,
  requestUrl,
  sendActorResponse,
  sendError,
  sendJson,
  sendPreflight,
  toActorRequest,
} from './http.js';
import { handleInternal } from './internal.js';
import { errorText } from './log.js';
import { BOOTSTRAP_PROOF_HEADER, chooseWorkspaceId, isWorkspaceIdTaken } from './workspaceId.js';

export const SERVICE_NAME = 'relaycast-actors-gateway';
/** How long a readiness answer from the control plane is reused. */
const READINESS_CACHE_MS = 5_000;
/** Between re-polls of an empty `GET /v1/deliveries?wait=`. */
const DELIVERY_POLL_INTERVAL_MS = 750;

export interface RequestHandlerOptions {
  /** True once shutdown began: new requests are refused with 503. */
  closing: () => boolean;
  onStart?: (res: ServerResponse) => void;
  onEnd?: (res: ServerResponse) => void;
}

interface Readiness {
  check(): Promise<boolean>;
}

function cachedReadiness(ctx: GatewayContext): Readiness {
  let cached: { at: number; ok: boolean } | undefined;
  let pending: Promise<boolean> | undefined;
  return {
    async check() {
      if (cached && Date.now() - cached.at < READINESS_CACHE_MS) return cached.ok;
      pending ??= ctx.actors.healthy().then((ok) => {
        cached = { at: Date.now(), ok };
        pending = undefined;
        return ok;
      });
      return pending;
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Whether `response` is a successful list whose `data` is empty. */
function isEmptyList(response: ActorHttpResponse): boolean {
  if (response.status !== 200) return false;
  try {
    const body = JSON.parse(response.body) as { ok?: unknown; data?: unknown };
    return body.ok === true && Array.isArray(body.data) && body.data.length === 0;
  } catch {
    return false;
  }
}

/**
 * The `wait` the client asked for on `GET /v1/deliveries`, in ms, when the
 * value is valid and positive. Anything else forwards unchanged and the actor
 * answers (at once, or with its own 400).
 */
function deliveriesWaitMs(req: IncomingMessage, url: URL): number | undefined {
  if (req.method !== 'GET' || url.pathname !== '/v1/deliveries' || !url.searchParams.has('wait')) return undefined;
  const parsed = ListDeliveriesQuerySchema.pick({ wait: true }).safeParse({ wait: url.searchParams.get('wait') });
  return parsed.success && parsed.data.wait ? parsed.data.wait : undefined;
}

/**
 * An actor answers `wait` at once (a waiter inside an actor call would hold
 * its mailbox), so the gateway parks the long-poll here: forward without
 * `wait`, and while the answer is an empty list and time remains, pause and
 * ask again. The last answer is returned when a delivery arrives, at the
 * deadline, or when the client goes away.
 */
async function longPollDeliveries(ctx: GatewayContext, workspaceId: string, request: ActorHttpRequest, url: URL, waitMs: number, signal: AbortSignal): Promise<ActorHttpResponse> {
  const deadline = Date.now() + waitMs;
  const forwardUrl = new URL(url);
  forwardUrl.searchParams.delete('wait');
  const forward = { ...request, url: forwardUrl.toString() };
  for (;;) {
    const response = await ctx.actors.handle(workspaceId, forward, { signal });
    const remaining = deadline - Date.now();
    if (!isEmptyList(response) || remaining <= 0 || signal.aborted) return response;
    await sleep(Math.min(remaining, DELIVERY_POLL_INTERVAL_MS), signal);
    if (signal.aborted) return response;
  }
}

export function createRequestHandler(ctx: GatewayContext, options: RequestHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const readiness = cachedReadiness(ctx);

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string, signal: AbortSignal, setWorkspace: (id: string) => void): Promise<void> {
    const path = url.pathname;
    if (path === ACTOR_FILE_ROUTE) {
      return serveFile(req, res, url, { store: ctx.files, secret: ctx.config.fileSigningSecret, maxUploadBytes: ctx.config.maxUploadBytes, logger: ctx.logger });
    }
    if (req.method === 'OPTIONS') return sendPreflight(req, res);
    if (path === '/health' || path === '/healthz') return sendJson(res, 200, { ok: true, service: SERVICE_NAME });
    if (path === '/readyz') {
      return (await readiness.check())
        ? sendJson(res, 200, { ok: true, data: { control_plane: 'ok' } })
        : sendError(res, 503, 'not_ready', 'The actor control plane is not reachable');
    }
    if (path === '/internal' || path.startsWith('/internal/')) {
      return handleInternal(ctx, { req, res, url, requestId, signal, setWorkspace });
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    if (req.method === 'POST' && path === '/v1/workspaces') {
      if (!ctx.config.publicWorkspaceCreate) return sendError(res, 404, 'not_found', 'Route not found');
      // Credentials carry a tag only this gateway's keyring signs, so a
      // credential naming a made-up workspace is refused here and never
      // creates an actor. A keyed create lands on an id derived from the key;
      // when the deployment requires proof of the bootstrap secret, an
      // anonymous keyed create is refused here without it, and the proof
      // travels on to the actor's engine with the other headers.
      const chosen = await chooseWorkspaceId(req, {
        bootstrapSecret: ctx.config.workspaceBootstrapSecret,
        proofRequired: ctx.config.workspaceBootstrapProofRequired,
      });
      if ('error' in chosen) return sendError(res, chosen.error.status, chosen.error.code, chosen.error.message);
      const workspaceId = chosen.workspaceId;
      setWorkspace(workspaceId);
      const body = await readBody(req, ctx.config.maxUploadBytes);
      let request = toActorRequest(req, url, body, requestId);
      const bearer = bearerToken(req);
      const owner = chosen.keyed && bearer ? parseArCredential(bearer) : undefined;
      if (owner?.kind === 'workspace') {
        // An owner-keyed create: the owner's key lives in the owner's actor,
        // which the child actor cannot consult. Authenticate it there, then
        // forward the create without the bearer; the owner is already in the
        // derived id, so the child's keyed-create record is the owner's.
        if (!(await ctx.credentialTags.verify(bearer!))) {
          return sendError(res, 401, 'unauthorized', 'An ar_ credential issued by this deployment is required');
        }
        const probe = await ctx.actors.handle(owner.workspaceId, {
          method: 'GET',
          url: `${url.origin}/v1/agents?limit=1`,
          headers: [['host', url.host], ['authorization', `Bearer ${bearer}`], [REQUEST_ID_HEADER, requestId]],
          body: null,
        }, { signal });
        if (probe.status === 401 || probe.status === 403) return sendError(res, 401, 'unauthorized', 'The owner credential was refused by its workspace');
        // Anything else (429 with its retry headers, a 5xx) is the owner workspace's answer, passed on so the client can retry.
        if (probe.status !== 200) return sendActorResponse(res, probe);
        // The child's engine then sees an anonymous keyed create, so when the
        // deployment requires proof the gateway proves the secret itself (as
        // the internal create does), in place of anything the client sent.
        const proof = ctx.config.workspaceBootstrapProofRequired ? ctx.config.workspaceBootstrapSecret : undefined;
        request = {
          ...request,
          headers: [
            ...request.headers.filter(([name]) => name !== 'authorization' && name !== BOOTSTRAP_PROOF_HEADER),
            ...(proof === undefined ? [] : [[BOOTSTRAP_PROOF_HEADER, proof] as [string, string]]),
          ],
        };
      }
      let response = await ctx.actors.create(workspaceId, request, await ctx.credentialTags.tag(workspaceId), { signal });
      if (!chosen.keyed && isWorkspaceIdTaken(response)) {
        // Two replicas minted the same snowflake in one millisecond: once more under a fresh one.
        const again = generateWorkspaceId();
        setWorkspace(again);
        response = await ctx.actors.create(again, request, await ctx.credentialTags.tag(again), { signal });
      }
      return sendActorResponse(res, response);
    }

    const token = bearerToken(req);
    const credential = token ? parseArCredential(token) : undefined;
    if (!token || !credential || !(await ctx.credentialTags.verify(token))) {
      return sendError(res, 401, 'unauthorized', 'An ar_ credential issued by this deployment is required');
    }
    const workspaceId = credential.workspaceId;
    setWorkspace(workspaceId);
    const body = hasBody ? await readBody(req, ctx.config.maxUploadBytes) : null;
    const request = toActorRequest(req, url, body, requestId);
    const waitMs = deliveriesWaitMs(req, url);
    const response = waitMs === undefined
      ? await ctx.actors.handle(workspaceId, request, { signal })
      : await longPollDeliveries(ctx, workspaceId, request, url, waitMs, signal);
    return sendActorResponse(res, response);
  }

  return (req, res) => {
    const started = performance.now();
    const requestId = requestIdFor(req);
    const url = requestUrl(req, ctx.fallbackHost());
    let workspaceId: string | undefined;
    const controller = new AbortController();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    options.onStart?.(res);
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
      options.onEnd?.(res);
      ctx.logger.info('http.request', {
        method: req.method,
        // Never the query: `/_relayfiles?token=` and `?token=` carry credentials.
        path: url?.pathname ?? req.url?.split('?')[0],
        status: res.headersSent ? res.statusCode : 0,
        ms: Math.round((performance.now() - started) * 10) / 10,
        request_id: requestId,
        workspace_id: workspaceId,
      });
    });

    if (options.closing()) {
      sendError(res, 503, 'shutting_down', 'The gateway is restarting; retry', CLOSE_AFTER);
      return;
    }
    if (!url) {
      sendError(res, 400, 'invalid_request', 'Invalid request target or Host header', CLOSE_AFTER);
      return;
    }

    route(req, res, url, requestId, controller.signal, (id) => { workspaceId = id; }).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof BodyTooLarge) {
        return sendError(res, 413, 'payload_too_large', `Request body exceeds ${error.limit} bytes`, CLOSE_AFTER);
      }
      if (error instanceof ActorCallError) {
        if (error.code === 'aborted') return res.destroy();
        ctx.logger.error('actor.call_failed', { request_id: requestId, workspace_id: workspaceId, code: error.code, error: errorText(error) });
        return sendError(res, 502, 'workspace_unavailable', 'The workspace could not be reached; retry');
      }
      ctx.logger.error('http.failed', { request_id: requestId, workspace_id: workspaceId, error: errorText(error) });
      return sendError(res, 500, 'internal_error', 'Internal server error');
    });
  };
}
