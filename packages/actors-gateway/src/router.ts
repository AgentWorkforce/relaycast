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
    if (path === ACTOR_FILE_ROUTE) return serveFile(req, res, url, { store: ctx.files, secret: ctx.config.fileSigningSecret, logger: ctx.logger });
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
      // creates an actor.
      const workspaceId = generateWorkspaceId();
      setWorkspace(workspaceId);
      const tag = await ctx.credentialTags.tag(workspaceId);
      const body = await readBody(req, ctx.config.maxUploadBytes);
      const response = await ctx.actors.create(workspaceId, toActorRequest(req, url, body, requestId), tag, { signal });
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
        path: url.pathname,
        status: res.headersSent ? res.statusCode : 0,
        ms: Math.round((performance.now() - started) * 10) / 10,
        request_id: requestId,
        workspace_id: workspaceId,
      });
    });

    if (options.closing()) {
      sendError(res, 503, 'shutting_down', 'The gateway is restarting; retry', { connection: 'close' });
      return;
    }

    route(req, res, url, requestId, controller.signal, (id) => { workspaceId = id; }).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof BodyTooLarge) {
        return sendError(res, 413, 'payload_too_large', `Request body exceeds ${error.limit} bytes`);
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
