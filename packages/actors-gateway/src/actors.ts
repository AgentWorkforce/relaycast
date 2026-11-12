/**
 * The durable-actors control plane, spoken directly over HTTP.
 *
 * The `durable-actors` package ships its client runtime (`createActorStub`,
 * `HttpActorClient`) only behind unexported `dist/client-runtime/*` paths and
 * declares a Bun engine, so this module mirrors that runtime's wire protocol
 * (0.14.6) with zod-validated replies instead of depending on it:
 *
 *   POST {origin}/v1/projects/{project}/actors/Workspace/{id}/invoke
 *        {requestId, method, args, homeRegion?} → {outcome}
 *   POST {origin}/v1/projects/{project}/actors/Workspace/{id}/find-websocket
 *        {metadata, homeRegion?} → {websocketUrl, homeRegion, connectByMs}
 *   GET  {origin}/healthz
 *
 * Every failure surfaces as an {@link ActorCallError}; the gateway answers
 * 502 `workspace_unavailable` and never shows a client the control plane's
 * URL or credential.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorHttpRequest, ActorHttpResponse } from '@relaycast/engine/gateway';

export const ACTOR_NAME = 'Workspace';
const DEFAULT_INVOKE_TIMEOUT_MS = 60_000;
/**
 * `create` activates a brand-new actor: on a production control plane that is a
 * host claim plus the first schema commit, so it gets its own, longer budget.
 */
const DEFAULT_CREATE_TIMEOUT_MS = 180_000;
const FIND_WEBSOCKET_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 3_000;
/** The control plane caps socket metadata at 16 KiB. */
const MAX_SOCKET_METADATA_BYTES = 16 * 1024;

export class ActorCallError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ActorCallError';
  }
}

export interface SocketGrant {
  /** Treat as a credential: it admits one connection to the actor. */
  websocketUrl: string;
  homeRegion: string;
  /** Unix milliseconds by which the connection must be opened. */
  connectByMs: number;
}

export interface CallOptions {
  /** Abort when the client goes away. */
  signal?: AbortSignal;
}

export interface ActorClient {
  create(workspaceId: string, request: ActorHttpRequest, credentialTag: string, options?: CallOptions): Promise<ActorHttpResponse>;
  handle(workspaceId: string, request: ActorHttpRequest, options?: CallOptions): Promise<ActorHttpResponse>;
  /** One migration import step (`migration/protocol.ts`); the body is the parsed JSON request. */
  importData(workspaceId: string, body: unknown, credentialTag: string, options?: CallOptions): Promise<ActorHttpResponse>;
  findWebsocket(workspaceId: string, metadata: unknown): Promise<SocketGrant>;
  /** Whether the control plane answers its health check. */
  healthy(): Promise<boolean>;
}

export interface ActorClientOptions {
  controlPlaneUrl: string;
  projectId: string;
  secret?: string | undefined;
  homeRegion?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Budget for one `handle` call (RELAYCAST_ACTOR_INVOKE_TIMEOUT_MS). */
  invokeTimeoutMs?: number;
  /** Budget for one `create` call (RELAYCAST_ACTOR_CREATE_TIMEOUT_MS). */
  createTimeoutMs?: number;
}

const ActorHttpResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
});

const OutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('completed'), result: z.unknown() }),
  z.object({ type: z.literal('failed'), code: z.string().min(1), message: z.string() }),
  z.object({ type: z.literal('not_executed'), reason: z.string() }),
  z.object({ type: z.literal('unauthenticated') }),
]);
const InvokeReplySchema = z.object({ outcome: OutcomeSchema });
const ErrorReplySchema = z.object({ error: z.object({ code: z.string().min(1), message: z.string() }) });
const SocketGrantSchema = z.object({
  websocketUrl: z.string().refine((value) => URL.canParse(value) && /^wss?:$/.test(new URL(value).protocol), 'not a ws(s) URL'),
  homeRegion: z.string().min(1),
  connectByMs: z.number().int(),
});

const ACTOR_COMPONENT = /^[A-Za-z0-9._-]+$/;

function actorPath(projectId: string, actorId: string): string {
  if (!ACTOR_COMPONENT.test(actorId) || actorId === '.' || actorId === '..') {
    throw new ActorCallError('invalid_actor_id', 'actor id may contain only ASCII letters, digits, ".", "-" and "_"');
  }
  return `/v1/projects/${encodeURIComponent(projectId)}/actors/${ACTOR_NAME}/${encodeURIComponent(actorId)}`;
}

function withTimeout(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * The reply body as JSON. Not JSON is a protocol error; a body that could not
 * be read is an unknown outcome, unless the client went away (the same
 * `aborted` the request path reports).
 */
async function jsonDocument(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ActorCallError('protocol', `control plane HTTP ${response.status} response was not JSON`, { cause: error });
    }
    if (signal.aborted && !isTimeout(signal)) throw new ActorCallError('aborted', 'the client went away', { cause: error });
    throw new ActorCallError('outcome_unknown', `control plane HTTP ${response.status} response body could not be read`, { cause: error });
  }
}

function isTimeout(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
}

export function createActorClient(options: ActorClientOptions): ActorClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  const createTimeoutMs = options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
  const authHeaders: Record<string, string> = options.secret ? { authorization: `Bearer ${options.secret}` } : {};

  async function post(path: string, body: unknown, requestId: string, signal: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(`${options.controlPlaneUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': requestId, ...authHeaders },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted && !isTimeout(signal)) {
        throw new ActorCallError('aborted', 'the client went away', { cause: error });
      }
      const cause = (error as { cause?: { code?: string } } | null)?.cause;
      const code = cause?.code === 'ECONNREFUSED' ? 'unavailable' : 'outcome_unknown';
      throw new ActorCallError(code, `control plane request failed (${cause?.code ?? (signal.aborted ? 'timeout' : 'fetch failed')})`, { cause: error });
    }
  }

  function failure(response: Response, document: unknown): ActorCallError {
    if (response.status === 401 || response.status === 403) {
      return new ActorCallError('unauthenticated', 'the control plane rejected the application credential');
    }
    const parsed = ErrorReplySchema.safeParse(document);
    return parsed.success
      ? new ActorCallError(parsed.data.error.code, parsed.data.error.message)
      : new ActorCallError('protocol', `control plane answered HTTP ${response.status}`);
  }

  async function invokeOnce(actorId: string, method: string, args: unknown[], signal: AbortSignal): Promise<z.infer<typeof OutcomeSchema>> {
    const requestId = randomUUID();
    const response = await post(`${actorPath(options.projectId, actorId)}/invoke`, {
      requestId,
      method,
      args,
      ...(options.homeRegion ? { homeRegion: options.homeRegion } : {}),
    }, requestId, signal);
    // A refused credential needs no body (a proxy's 401 is rarely JSON); the
    // body is still released so the socket goes back to the pool.
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(response, undefined);
    }
    const document = await jsonDocument(response, signal);
    if (!response.ok) throw failure(response, document);
    const parsed = InvokeReplySchema.safeParse(document);
    if (!parsed.success) throw new ActorCallError('protocol', 'control plane reply carried no valid outcome');
    return parsed.data.outcome;
  }

  async function invoke(actorId: string, method: 'create' | 'handle' | 'importData', args: unknown[], callOptions?: CallOptions): Promise<ActorHttpResponse> {
    // An import's first step activates a brand-new actor, like `create`.
    const signal = withTimeout(method === 'handle' ? invokeTimeoutMs : createTimeoutMs, callOptions?.signal);
    // A `not_executed` outcome means the host never ran the call; one retry, as the SDK does.
    let outcome = await invokeOnce(actorId, method, args, signal);
    if (outcome.type === 'not_executed') outcome = await invokeOnce(actorId, method, args, signal);
    switch (outcome.type) {
      case 'completed': {
        const result = ActorHttpResponseSchema.safeParse(outcome.result);
        if (!result.success) throw new ActorCallError('protocol', `actor ${method} returned no HTTP response`);
        return result.data;
      }
      case 'failed':
        throw new ActorCallError(outcome.code, outcome.message);
      case 'unauthenticated':
        throw new ActorCallError('unauthenticated', 'the actor host rejected the invocation');
      case 'not_executed':
        throw new ActorCallError('unavailable', `the actor host did not run the call (${outcome.reason})`);
    }
  }

  return {
    create: (workspaceId, request, credentialTag, callOptions) => invoke(workspaceId, 'create', [request, credentialTag], callOptions),
    handle: (workspaceId, request, callOptions) => invoke(workspaceId, 'handle', [request], callOptions),
    importData: (workspaceId, body, credentialTag, callOptions) => invoke(workspaceId, 'importData', [body, credentialTag], callOptions),

    async findWebsocket(workspaceId, metadata) {
      const encoded = JSON.stringify(metadata);
      if (encoded === undefined || Buffer.byteLength(encoded) > MAX_SOCKET_METADATA_BYTES) {
        throw new ActorCallError('invalid_metadata', 'socket metadata must be JSON of at most 16 KiB');
      }
      const requestId = randomUUID();
      const signal = withTimeout(FIND_WEBSOCKET_TIMEOUT_MS, undefined);
      const response = await post(`${actorPath(options.projectId, workspaceId)}/find-websocket`, {
        metadata,
        ...(options.homeRegion ? { homeRegion: options.homeRegion } : {}),
      }, requestId, signal);
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw failure(response, undefined);
      }
      const document = await jsonDocument(response, signal);
      if (!response.ok) throw failure(response, document);
      const grant = SocketGrantSchema.safeParse(document);
      if (!grant.success) throw new ActorCallError('protocol', 'control plane returned an invalid socket grant');
      return grant.data;
    },

    async healthy() {
      try {
        const response = await fetchImpl(`${options.controlPlaneUrl}/healthz`, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        await response.body?.cancel();
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
