import type { DelegationRequest, GitHubEnumerationParams, GitHubInvestigationParams, LinearEnumerationParams, SpecialistFinding, SpecialistFindings } from '@agent-assistant/specialists';
import { RelayAuthError, TokenVerifier, type RelayAuthTokenClaims } from '@relayauth/sdk';
import { RelayFileClient } from '@relayfile/sdk';
import type { Context } from 'hono';
import { A2aMessageSchema, JsonRpcRequestSchema, type A2aJsonRpcRequest, type A2aMessage, type A2aTask } from '@relaycast/a2a';
import { createGitHubAgenticSpecialist } from '../specialist/github-specialist-agentic.js';
import { createLinearAgenticSpecialist } from '../specialist/linear-specialist-agentic.js';
import { createNotionLibrarianApiFallback } from '../specialist/notion-api-fallback.js';
import { createNotionIntegration } from '../specialist/notion-api-client.js';
import { createNotionAgenticSpecialist, type NotionEnumerationParams } from '../specialist/notion-specialist-agentic.js';
import { createCloneRequester, type CloneRequester } from '../specialist/clone-requester.js';
import {
  createGitHubApiFallback,
  createGitHubLibrarianApiFallback,
} from '../specialist/github-api-client.js';
import { createLinearIntegration } from '../specialist/linear-api-client.js';
import { createLinearLibrarianApiFallback } from '../specialist/linear-api-fallback.js';
const DEFAULT_RELAYAUTH_URL = 'https://api.relayauth.dev';
const DEFAULT_RELAYFILE_URL = 'https://api.relayfile.dev';
const SPECIALIST_WORKER_AGENT_NAME = 'specialist-worker';
const TASK_TTL_MS = 60 * 60 * 1000;
// Specialist only reads from relayfile; never writes.
const RELAYFILE_TOKEN_SCOPES = ['fs:read'];
const RELAYFILE_TOKEN_TTL_SECONDS = 3600;
const RELAYFILE_IDENTITY_CACHE_TTL_MS = 30 * 60 * 1000;
const DEBUG_LOG_PREFIX = '[specialist/a2a-rpc]';

interface CachedRelayFileIdentity {
  id: string;
  expiresAt: number;
}

const relayFileIdentityCache = new Map<string, CachedRelayFileIdentity>();
const relayFileIdentityInflight = new Map<string, Promise<string>>();

/**
 * Gate verbose a2a-rpc diagnostics behind the `DEBUG_SPECIALIST` env flag.
 *
 * Bindings on Cloudflare Workers land on the handler `env` argument, not
 * `globalThis.process.env` — the `nodejs_compat` polyfill only populates
 * process.env with node defaults unless a newer compat date is combined
 * with `nodejs_compat_populate_process_env`. Read from the bindings
 * record directly so setting `DEBUG_SPECIALIST=true` in CF actually
 * flips the gate.
 */
function isDebugSpecialistEnabled(bindings: Bindings | undefined): boolean {
  return bindings?.DEBUG_SPECIALIST === 'true';
}
function debugLog(bindings: Bindings | undefined, message: string, payload: Record<string, unknown>): void {
  if (isDebugSpecialistEnabled(bindings)) console.log(DEBUG_LOG_PREFIX, message, payload);
}

// See .claude/rules/workers-fetch.md — `globalThis.fetch` preserves the
// `this` binding under nodejs_compat AND stays test-stubbable.
async function callFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}
type JsonRpcId = string | number | undefined;
type JsonRpcRequest = A2aJsonRpcRequest;
type Bindings = {
  OPENROUTER_API_KEY?: string;
  RELAYAUTH_API_URL?: string;
  RELAYAUTH_AUDIENCE?: string;
  RELAYAUTH_ISSUER?: string;
  RELAYAUTH_JWKS_URL?: string;
  RELAYAUTH_URL?: string;
  SPECIALIST_RELAYAUTH_URL?: string;
  SPECIALIST_RELAYAUTH_API_KEY?: string;
  RELAYFILE_URL?: string;
  /**
   * Base URL of the cloud web app (e.g. https://cloud.agentrelay.com). Paired
   * with SPECIALIST_CLOUD_API_TOKEN for both GitHub API proxying via Nango and
   * fire-and-forget clone triggers. When either is unset, the specialist
   * falls back to VFS-only behaviour.
   */
  CLOUD_API_URL?: string;
  /**
   * Optional diagnostic toggle. When `"true"`, verbose logging fires in
   * a2a-rpc + agentic-specialist. Set as a plain_text binding on the
   * Worker (NOT a secret) so the env-exposed value is the literal
   * string "true".
   */
  DEBUG_SPECIALIST?: string;
  /**
   * Bearer token for cloud web's specialist endpoints. The web side resolves
   * per-workspace GitHub credentials through Nango; the worker never receives
   * GitHub tokens.
   */
  SPECIALIST_CLOUD_API_TOKEN?: string;
};
type AppEnv = { Bindings: Bindings; Variables: { config: { relayAuthAudience?: string[]; relayAuthIssuer: string; relayAuthJwksUrl: string } } };
type LinearDelegationRequest = { requestId: string; capability: 'linear.enumerate'; params: LinearEnumerationParams; timeoutMs?: number; metadata?: Record<string, unknown> };
type LinearSpecialistFindings = { requestId: string; capability: 'linear.enumerate'; status: 'complete' | 'partial' | 'failed'; summary: string; findings: SpecialistFinding[]; confidence?: number; metadata?: Record<string, unknown> };
type NotionDelegationRequest = { requestId: string; capability: 'notion.enumerate'; params: NotionEnumerationParams; timeoutMs?: number; metadata?: Record<string, unknown> };
type NotionSpecialistFindings = { requestId: string; capability: 'notion.enumerate'; status: 'complete' | 'partial' | 'failed'; summary: string; findings: SpecialistFinding[]; confidence?: number; metadata?: Record<string, unknown> };
type SupportedDelegationRequest = DelegationRequest | LinearDelegationRequest | NotionDelegationRequest;
type SupportedSpecialistFindings = SpecialistFindings | LinearSpecialistFindings | NotionSpecialistFindings;
type BaseDelegationRequest = { requestId: string; capability: string; params: Record<string, unknown>; timeoutMs?: number; metadata?: Record<string, unknown> };
type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string };
export interface A2aTaskStore {
  get(taskId: string): A2aTask | undefined;
  set(task: A2aTask): void;
  cancel(taskId: string): A2aTask | undefined;
}
export function createInMemoryTaskStore(ttlMs = TASK_TTL_MS): A2aTaskStore {
  const tasks = new Map<string, { task: A2aTask; expiresAt: number }>();
  const get = (taskId: string) => {
    const entry = tasks.get(taskId);
    if (!entry) return undefined;
    if (entry.expiresAt > Date.now()) return entry.task;
    tasks.delete(taskId);
    return undefined;
  };
  return {
    get,
    set: (task) => tasks.set(task.id, { task, expiresAt: Date.now() + ttlMs }),
    cancel(taskId) {
      const task = get(taskId);
      if (!task) return undefined;
      const canceled = { ...task, status: { ...task.status, state: 'canceled' as const } };
      this.set(canceled);
      return canceled;
    },
  };
}
export const defaultA2aTaskStore = createInMemoryTaskStore();
export async function handleA2aRpc(c: Context<AppEnv>, store: A2aTaskStore = defaultA2aTaskStore) {
  let request: JsonRpcRequest;
  let id: JsonRpcId;
  try {
    request = JsonRpcRequestSchema.parse(await c.req.json());
    id = request.id;
  } catch (error) {
    return c.json(rpcError(undefined, -32600, 'Invalid Request', zodData(error)));
  }
  console.log('[specialist/a2a-rpc] request:', {
    method: request.method,
    hasAuthHeader: !!c.req.header('authorization'),
    bodyKeys: Object.keys(request.params ?? {}),
  });
  try {
    if (request.method === 'message/send') {
      return c.json(rpcResult(id, await messageSend(c, request, store)));
    }
    if (request.method === 'tasks/get') {
      const taskId = taskIdFrom(request.params);
      const task = store.get(taskId);
      return c.json(rpcResult(id, task ? { task } : notFound(taskId)));
    }
    if (request.method === 'tasks/cancel') {
      const taskId = taskIdFrom(request.params);
      const task = store.cancel(taskId);
      return c.json(rpcResult(id, task ? { task } : notFound(taskId)));
    }
    return c.json(rpcError(id, -32601, 'Method not found'));
  } catch (error) {
    const normalized = normalizeError(error);
    console.log('[specialist/a2a-rpc] request failed:', {
      rpcCode: normalized.rpcCode,
      code: normalized.code,
      status: normalized.status,
      errorMessage: normalized.error,
    });
    debugLog(c.env, 'a2a-rpc error', {
      rpcCode: normalized.rpcCode,
      httpStatusEquivalent: normalized.status,
      code: normalized.code,
      message: normalized.error,
    });
    return c.json(rpcError(id, normalized.rpcCode, normalized.error, {
      code: normalized.code,
      status: normalized.status,
    }));
  }
}
export async function delegateMessage(c: Context<AppEnv>, message: A2aMessage, metadata: Record<string, unknown> = {}): Promise<SupportedSpecialistFindings> {
  let claims: RelayAuthTokenClaims;
  try {
    claims = await verifyBearerToken(c);
  } catch (err) {
    const relay = err instanceof RelayAuthError
      ? {
          name: 'RelayAuthError',
          code: (err as RelayAuthError & { code?: string }).code,
          status: (err as RelayAuthError & { status?: number; statusCode?: number }).status ?? (err as RelayAuthError & { statusCode?: number }).statusCode,
          reason: (err as RelayAuthError & { reason?: string }).reason,
        }
      : err instanceof Error
        ? { name: err.constructor.name, message: err.message }
        : { name: typeof err, message: String(err) };
    console.log('[specialist/a2a-rpc] verify failed:', relay);
    throw err;
  }
  const workspaceId = resolveWorkspaceId(claims);
  debugLog(c.env, 'incoming delegation', {
    messageId: message.message_id,
    tokenSub: claims.sub,
    tokenWks: claims.wks ?? claims.workspace_id,
    tokenSponsor: claims.sponsorId,
    tokenScopes: Array.isArray(claims.scopes) ? claims.scopes : undefined,
    resolvedWorkspaceId: workspaceId,
  });
  const parsed = parseBaseDelegationRequest(messageToDelegationBody(message, metadata));
  if (parsed.ok === false) {
    console.log('[specialist/a2a-rpc] parse/narrow failed:', { stage: 'parse', error: parsed.error, code: parsed.code });
    debugLog(c.env, 'parse failed', { error: parsed.error, code: parsed.code });
    throw new ClientError(parsed.error, parsed.code);
  }
  const narrowed = narrowDelegationRequest(parsed.value);
  if (narrowed.ok === false) {
    console.log('[specialist/a2a-rpc] parse/narrow failed:', { stage: 'narrow', error: narrowed.error, code: narrowed.code });
    debugLog(c.env, 'narrow failed', { error: narrowed.error, code: narrowed.code, capability: parsed.value.capability });
    throw new ClientError(narrowed.error, narrowed.code);
  }
  debugLog(c.env, 'narrow ok', { capability: narrowed.value.capability, requestId: narrowed.value.requestId });
  const findings = await delegateToSpecialist(withWorkspaceMetadata(narrowed.value, workspaceId), c.env, workspaceId);
  debugLog(c.env, 'delegation complete', {
    requestId: findings.requestId,
    capability: findings.capability,
    status: findings.status,
    findingsCount: findings.findings.length,
  });
  return findings;
}
async function messageSend(c: Context<AppEnv>, request: JsonRpcRequest, store: A2aTaskStore): Promise<{ task: A2aTask; message: A2aMessage }> {
  const message = A2aMessageSchema.parse(request.params?.message);
  const metadata = isRecord(request.params?.metadata) ? request.params.metadata : {};
  const findings = await delegateMessage(c, message, metadata);
  const responseMessage: A2aMessage = {
    message_id: `${message.message_id}-response`,
    role: 'agent',
    context_id: message.context_id,
    parts: [{ kind: 'text', text: JSON.stringify(findings) }],
  };
  const task: A2aTask = {
    id: findings.requestId || message.message_id,
    context_id: message.context_id,
    status: { state: 'completed' },
    artifacts: [{ name: 'specialist-findings', parts: responseMessage.parts }],
    history: [message, responseMessage],
    metadata: { capability: findings.capability },
  };
  store.set(task);
  return { task, message: responseMessage };
}
function messageToDelegationBody(message: A2aMessage, metadata: Record<string, unknown>): Record<string, unknown> {
  const textPart = message.parts.find(isTextPart);
  const payload = textPart ? parseJsonObject(textPart.text) : {};
  if (isRecord(payload.params) && isNonEmptyString(payload.capability)) return payload;
  const capability = readString(payload.capability) ?? readString(metadata.capability);
  if (!capability) throw new ClientError('message/send requires a capability', 'missing_capability');
  return {
    requestId: readString(payload.requestId) ?? message.message_id,
    capability,
    params: isRecord(payload.params) ? payload.params : { ...payload, capability },
    timeoutMs: payload.timeoutMs,
    metadata,
  };
}
function parseBaseDelegationRequest(value: unknown): ParseResult<BaseDelegationRequest> {
  if (!isRecord(value)) return invalid('DelegationRequest body must be an object');
  if (!isNonEmptyString(value.requestId)) return invalid('DelegationRequest.requestId must be a non-empty string');
  if (!isNonEmptyString(value.capability)) return invalid('DelegationRequest.capability must be a non-empty string');
  if (!isRecord(value.params)) return invalid('DelegationRequest.params must be an object');
  if (value.timeoutMs !== undefined && !isFiniteNumber(value.timeoutMs)) return invalid('DelegationRequest.timeoutMs must be a finite number');
  if (value.metadata !== undefined && !isRecord(value.metadata)) return invalid('DelegationRequest.metadata must be an object');
  if (value.params.capability !== value.capability) return invalid('DelegationRequest.params.capability must match DelegationRequest.capability');
  return {
    ok: true,
    value: {
      requestId: value.requestId.trim(),
      capability: value.capability.trim(),
      params: value.params,
      timeoutMs: readNumber(value.timeoutMs),
      metadata: readMetadata(value.metadata),
    },
  };
}
function narrowDelegationRequest(request: BaseDelegationRequest): ParseResult<SupportedDelegationRequest> {
  switch (request.capability) {
    case 'pr_investigation':
    case 'github.investigate':
      if (!isNonEmptyString(request.params.query)) return invalid('GitHub investigation requests require params.query');
      if (!validOptionalFilters(request.params.filters)) return invalid('GitHub investigation params.filters must be a string[] record');
      if (!validOptionalNumber(request.params.limit)) return invalid('GitHub investigation params.limit must be a finite number');
      if (request.params.pr !== undefined && !isPullRequestRef(request.params.pr)) return invalid('GitHub investigation params.pr must be a valid pull request reference');
      return okRequest(request, {
        capability: request.capability,
        query: request.params.query,
        filters: readFilters(request.params.filters),
        limit: readNumber(request.params.limit),
        pr: request.params.pr as GitHubInvestigationParams['pr'] | undefined,
      } as GitHubInvestigationParams);
    case 'github.enumerate':
      if (!validOptionalString(request.params.query)) return invalid('GitHub enumeration params.query must be a string');
      if (!validOptionalFilters(request.params.filters)) return invalid('GitHub enumeration params.filters must be a string[] record');
      if (!validOptionalString(request.params.cursor)) return invalid('GitHub enumeration params.cursor must be a string');
      if (!validOptionalNumber(request.params.limit)) return invalid('GitHub enumeration params.limit must be a finite number');
      return okRequest(request, {
        capability: 'github.enumerate',
        query: readString(request.params.query),
        filters: readFilters(request.params.filters),
        cursor: readString(request.params.cursor),
        limit: readNumber(request.params.limit),
      } as GitHubEnumerationParams);
    case 'linear.enumerate':
      if (!validOptionalString(request.params.query)) return invalid('Linear enumeration params.query must be a string');
      if (!validOptionalFilters(request.params.filters)) return invalid('Linear enumeration params.filters must be a string[] record');
      if (!validOptionalString(request.params.cursor)) return invalid('Linear enumeration params.cursor must be a string');
      if (!validOptionalNumber(request.params.limit)) return invalid('Linear enumeration params.limit must be a finite number');
      return okRequest(request, {
        capability: 'linear.enumerate',
        query: readString(request.params.query),
        filters: readFilters(request.params.filters),
        cursor: readString(request.params.cursor),
        limit: readNumber(request.params.limit),
      } as LinearEnumerationParams);
    case 'notion.enumerate':
      if (!validOptionalString(request.params.query)) return invalid('Notion enumeration params.query must be a string');
      if (!validOptionalFilters(request.params.filters)) return invalid('Notion enumeration params.filters must be a string[] record');
      if (!validOptionalString(request.params.cursor)) return invalid('Notion enumeration params.cursor must be a string');
      if (!validOptionalNumber(request.params.limit)) return invalid('Notion enumeration params.limit must be a finite number');
      return okRequest(request, {
        capability: 'notion.enumerate',
        query: readString(request.params.query),
        filters: readFilters(request.params.filters),
        cursor: readString(request.params.cursor),
        limit: readNumber(request.params.limit),
      } as NotionEnumerationParams);
    default:
      return { ok: false, error: `Unknown capability: ${request.capability}`, code: 'unknown_capability' };
  }
}
function okRequest<T extends SupportedDelegationRequest['params']>(request: BaseDelegationRequest, params: T): ParseResult<SupportedDelegationRequest> {
  return {
    ok: true,
    value: {
      requestId: request.requestId,
      capability: params.capability,
      params,
      timeoutMs: request.timeoutMs,
      metadata: request.metadata,
    } as SupportedDelegationRequest,
  };
}
async function delegateToSpecialist(request: SupportedDelegationRequest, bindings: Bindings, workspaceId: string): Promise<SupportedSpecialistFindings> {
  const relayFile = await createRelayFileClient(bindings, workspaceId);
  const apiKey = getRequiredEnv(bindings, 'OPENROUTER_API_KEY');
  if (request.capability === 'linear.enumerate') {
    const linearOptions = buildLinearFallbackOptions(bindings, workspaceId);
    return createLinearAgenticSpecialist({
      relayFile,
      workspaceId,
      apiKey,
      ...(linearOptions.librarianApiFallback ? { linearLibrarianApiFallback: linearOptions.librarianApiFallback } : {}),
      ...(bindings.DEBUG_SPECIALIST ? { debugSpecialist: bindings.DEBUG_SPECIALIST } : {}),
    }).transport.delegate(request);
  }
  if (request.capability === 'notion.enumerate') {
    const cloudApiUrl = bindings.CLOUD_API_URL?.trim();
    const cloudApiToken = bindings.SPECIALIST_CLOUD_API_TOKEN?.trim();
    const notionApiFallback = cloudApiUrl && cloudApiToken
      ? createNotionLibrarianApiFallback(createNotionIntegration({
        cloudApiUrl,
        cloudApiToken,
        workspaceId,
      }))
      : undefined;
    return createNotionAgenticSpecialist({
      relayFile,
      workspaceId,
      apiKey,
      ...(notionApiFallback ? { apiFallback: notionApiFallback } : {}),
      ...(bindings.DEBUG_SPECIALIST ? { debugSpecialist: bindings.DEBUG_SPECIALIST } : {}),
    }).transport.delegate(request);
  }

  // Build the GitHub API + clone-on-demand fallbacks. Both depend on the
  // cloud web specialist bearer token because cloud web owns the per-
  // workspace Nango GitHub credential.
  const githubOptions = buildGitHubFallbackOptions(bindings, workspaceId);

  const specialist = createGitHubAgenticSpecialist({
    relayFile,
    workspaceId,
    apiKey,
    ...(githubOptions.apiFallback ? { githubApiFallback: githubOptions.apiFallback } : {}),
    ...(githubOptions.librarianApiFallback ? { githubLibrarianApiFallback: githubOptions.librarianApiFallback } : {}),
    ...(bindings.DEBUG_SPECIALIST ? { debugSpecialist: bindings.DEBUG_SPECIALIST } : {}),
  });
  // Narrow SupportedDelegationRequest back to the GitHub branch for the
  // transport's generic delegate. The linear case returned above, so by
  // construction `request` is one of {pr_investigation, github.investigate,
  // github.enumerate}. Branch-split the call so each arm supplies a
  // single-capability request to the generic signature.
  if (request.capability === 'github.enumerate') {
    return specialist.transport.delegate(request);
  }
  return specialist.transport.delegate(request);
}

interface GitHubFallbackOptions {
  apiFallback?: ReturnType<typeof createGitHubApiFallback>;
  librarianApiFallback?: ReturnType<typeof createGitHubLibrarianApiFallback>;
  cloneRequester?: CloneRequester;
}

interface LinearFallbackOptions {
  librarianApiFallback?: ReturnType<typeof createLinearLibrarianApiFallback>;
}

function buildLinearFallbackOptions(
  bindings: Bindings,
  workspaceId: string,
): LinearFallbackOptions {
  const cloudApiUrl = bindings.CLOUD_API_URL?.trim();
  const cloudApiToken = bindings.SPECIALIST_CLOUD_API_TOKEN?.trim();

  if (!cloudApiUrl || !cloudApiToken) {
    return {};
  }

  const linear = createLinearIntegration({
    cloudApiUrl,
    cloudApiToken,
    workspaceId,
    fetchImpl: callFetch,
  });

  const librarianApiFallback = createLinearLibrarianApiFallback(linear);

  return { librarianApiFallback };
}

function buildGitHubFallbackOptions(
  bindings: Bindings,
  workspaceId: string,
): GitHubFallbackOptions {
  const cloudApiUrl = bindings.CLOUD_API_URL?.trim();
  const cloudApiToken = bindings.SPECIALIST_CLOUD_API_TOKEN?.trim();

  // Unconditional diagnostic: helps operators confirm bindings are actually
  // reaching the deployed worker. This logs only the presence of each
  // binding, not the value itself. Safe to leave in prod — cheap + small.
  console.log('[specialist/a2a-rpc] fallback gating:', {
    hasCloudApiUrl: !!cloudApiUrl,
    cloudApiUrlLength: cloudApiUrl?.length ?? 0,
    hasCloudApiToken: !!cloudApiToken,
    cloudApiTokenLength: cloudApiToken?.length ?? 0,
    debugSpecialist: bindings.DEBUG_SPECIALIST === 'true' ? 'true' : `not-true (${bindings.DEBUG_SPECIALIST === undefined ? 'unset' : 'set-non-true'})`,
    workspaceId,
  });

  if (!cloudApiUrl || !cloudApiToken) {
    return {};
  }

  const cloneRequester = createCloneRequester({
    cloudApiUrl,
    cloudApiToken,
  });

  const apiFallback = createGitHubApiFallback({
    cloudApiUrl,
    cloudApiToken,
    cloneRequester,
    workspaceId,
  });

  const librarianApiFallback = createGitHubLibrarianApiFallback({
    cloudApiUrl,
    cloudApiToken,
    cloneRequester,
    workspaceId,
  });

  return { apiFallback, librarianApiFallback, cloneRequester };
}
async function verifyBearerToken(c: Context<AppEnv>): Promise<RelayAuthTokenClaims> {
  const token = readBearerToken(c.req.header('Authorization'));
  const config = c.get('config') ?? resolveConfig(c.env);
  return new TokenVerifier({
    jwksUrl: config.relayAuthJwksUrl,
    issuer: config.relayAuthIssuer,
    ...(config.relayAuthAudience ? { audience: config.relayAuthAudience } : {}),
  }).verify(token);
}
async function createRelayFileClient(bindings: Bindings, workspaceId: string) {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new SpecialistInternalError('workspaceId is required to mint a relayfile token', 'specialist_configuration_error');
  }
  const relayAuthUrl = getRequiredEnv(bindings, 'SPECIALIST_RELAYAUTH_URL');
  const relayAuthApiKey = getRequiredEnv(bindings, 'SPECIALIST_RELAYAUTH_API_KEY');
  const baseUrl = relayAuthUrl.endsWith('/') ? relayAuthUrl : `${relayAuthUrl}/`;

  const identity = await getRelayFileIdentity(baseUrl, relayAuthApiKey, normalizedWorkspaceId);
  const tokenPair = await mintRelayFileToken(baseUrl, relayAuthApiKey, identity.id).catch(async (error) => {
    if (!identity.fromCache || !isStaleIdentityTokenMintError(error)) {
      throw error;
    }
    relayFileIdentityCache.delete(identity.cacheKey);
    const refreshed = await getRelayFileIdentity(baseUrl, relayAuthApiKey, normalizedWorkspaceId, { forceCreate: true });
    return mintRelayFileToken(baseUrl, relayAuthApiKey, refreshed.id);
  });

  return new RelayFileClient({
    baseUrl: trimTrailingSlash(bindings.RELAYFILE_URL?.trim() || DEFAULT_RELAYFILE_URL),
    token: tokenPair.accessToken,
    readCache: {},
  });
}

async function getRelayFileIdentity(
  baseUrl: string,
  relayAuthApiKey: string,
  normalizedWorkspaceId: string,
  options: { forceCreate?: boolean } = {},
): Promise<{ id: string; cacheKey: string; fromCache: boolean }> {
  const cacheKey = `${baseUrl}|${normalizedWorkspaceId}`;
  const cached = relayFileIdentityCache.get(cacheKey);
  if (!options.forceCreate && cached && cached.expiresAt > Date.now()) {
    return { id: cached.id, cacheKey, fromCache: true };
  }
  if (cached) {
    relayFileIdentityCache.delete(cacheKey);
  }
  const inflight = relayFileIdentityInflight.get(cacheKey);
  if (inflight) {
    return { id: await inflight, cacheKey, fromCache: false };
  }

  const promise = createRelayFileIdentity(baseUrl, relayAuthApiKey, normalizedWorkspaceId)
    .then((identity) => {
      relayFileIdentityCache.set(cacheKey, {
        id: identity.id,
        expiresAt: Date.now() + RELAYFILE_IDENTITY_CACHE_TTL_MS,
      });
      return identity.id;
    })
    .finally(() => {
      relayFileIdentityInflight.delete(cacheKey);
    });
  relayFileIdentityInflight.set(cacheKey, promise);
  return { id: await promise, cacheKey, fromCache: false };
}

async function createRelayFileIdentity(
  baseUrl: string,
  relayAuthApiKey: string,
  normalizedWorkspaceId: string,
): Promise<{ id: string }> {
  const safeWorkspace = normalizedWorkspaceId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32);
  const identityName = `${SPECIALIST_WORKER_AGENT_NAME}-${safeWorkspace}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

  return relayAuthRequest<{ id: string }>(baseUrl, relayAuthApiKey, '/v1/identities', {
    method: 'POST',
    body: {
      name: identityName,
      type: 'agent',
      sponsorId: SPECIALIST_WORKER_AGENT_NAME,
      scopes: RELAYFILE_TOKEN_SCOPES,
      metadata: { agentName: SPECIALIST_WORKER_AGENT_NAME, productId: 'specialist', relayfileWorkspaceId: normalizedWorkspaceId },
      workspaceId: normalizedWorkspaceId,
    },
  });
}

async function mintRelayFileToken(
  baseUrl: string,
  relayAuthApiKey: string,
  identityId: string,
): Promise<{ accessToken: string }> {
  return relayAuthRequest<{ accessToken: string }>(baseUrl, relayAuthApiKey, '/v1/tokens', {
    method: 'POST',
    body: {
      identityId,
      scopes: RELAYFILE_TOKEN_SCOPES,
      audience: ['relayfile'],
      expiresIn: RELAYFILE_TOKEN_TTL_SECONDS,
    },
  });
}

function isStaleIdentityTokenMintError(error: unknown): boolean {
  return error instanceof SpecialistInternalError
    && error.code === 'specialist_relayauth_error'
    && /\((404|410)\)\s+\/v1\/tokens/.test(error.message);
}

export function resetRelayFileIdentityCacheForTests(): void {
  relayFileIdentityCache.clear();
  relayFileIdentityInflight.clear();
}

/**
 * Direct HTTP call to RelayAuth via `globalThis.fetch`. Intentionally skips
 * `@relayauth/sdk`'s `RelayAuthClient._request` because that transport calls
 * bare `fetch(...)`, which Workers+esbuild detaches from globalThis and
 * throws "Illegal invocation". See .claude/rules/workers-fetch.md.
 */
async function relayAuthRequest<T>(baseUrl: string, apiKey: string, path: string, init: { method?: string; body?: unknown; headers?: HeadersInit } = {}): Promise<T> {
  const url = new URL(path, baseUrl);
  const headers = new Headers(init.headers);
  headers.set('x-api-key', apiKey);
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.body);
  }
  const response = await callFetch(url.toString(), { method: init.method, headers, body });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SpecialistInternalError(
      detail ? `RelayAuth request failed (${response.status}) ${path}: ${detail}` : `RelayAuth request failed (${response.status}) ${path}`,
      'specialist_relayauth_error',
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
class ClientError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
class SpecialistInternalError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
const rpcResult = (id: JsonRpcId, result: Record<string, unknown>) => ({ jsonrpc: '2.0' as const, id, result });
const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0' as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const invalid = (error: string): ParseResult<never> => ({ ok: false, error, code: 'invalid_delegation_request' });
const notFound = (id: string) => ({ status: 'not_found', task: { id, status: { state: 'unknown' as const } } });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isTextPart = (part: { kind: string }): part is { kind: 'text'; text: string } => part.kind === 'text' && 'text' in part;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isStringArrayRecord = (value: unknown): value is Record<string, string[]> => isRecord(value) && Object.values(value).every(isStringArray);
const isPullRequestRef = (value: unknown): value is GitHubInvestigationParams['pr'] => isRecord(value) && isNonEmptyString(value.owner) && isNonEmptyString(value.repo) && Number.isInteger(value.number) && (value.number as number) > 0;
const validOptionalString = (value: unknown) => value === undefined || typeof value === 'string';
const validOptionalNumber = (value: unknown) => value === undefined || isFiniteNumber(value);
const validOptionalFilters = (value: unknown) => value === undefined || isStringArrayRecord(value);
const readString = (value: unknown) => typeof value === 'string' ? value : undefined;
const readNumber = (value: unknown) => isFiniteNumber(value) ? value : undefined;
const readMetadata = (value: unknown) => isRecord(value) ? value : undefined;
const readFilters = (value: unknown) => isStringArrayRecord(value) ? value : undefined;
const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');
const parseJsonObject = (text: string) => {
  try { const parsed: unknown = JSON.parse(text); return isRecord(parsed) ? parsed : {}; } catch { return {}; }
};
const taskIdFrom = (params: unknown) => {
  if (isRecord(params) && isNonEmptyString(params.id)) return params.id.trim();
  throw new ClientError('tasks/get and tasks/cancel require params.id', 'invalid_task_id');
};
const getRequiredEnv = (bindings: Bindings, key: 'OPENROUTER_API_KEY' | 'SPECIALIST_RELAYAUTH_URL' | 'SPECIALIST_RELAYAUTH_API_KEY') => {
  const value = bindings[key]?.trim();
  if (!value) throw new SpecialistInternalError(`${key} is required`, 'specialist_configuration_error');
  return value;
};
const resolveConfig = (bindings: Bindings) => {
  const relayAuthUrl = trimTrailingSlash(bindings.RELAYAUTH_URL?.trim() || bindings.RELAYAUTH_API_URL?.trim() || DEFAULT_RELAYAUTH_URL);
  return {
    relayAuthAudience: bindings.RELAYAUTH_AUDIENCE?.split(',').map((entry) => entry.trim()).filter(Boolean),
    relayAuthIssuer: bindings.RELAYAUTH_ISSUER?.trim() || relayAuthUrl,
    relayAuthJwksUrl: bindings.RELAYAUTH_JWKS_URL?.trim() || `${relayAuthUrl}/.well-known/jwks.json`,
  };
};
const readBearerToken = (authorization: string | undefined) => {
  const match = authorization && /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match?.[1]) throw new RelayAuthError('Missing Authorization header', 'missing_authorization', 401);
  return match[1].trim();
};
const resolveWorkspaceId = (claims: RelayAuthTokenClaims) => {
  const workspaceId = claims.wks?.trim() || claims.workspace_id?.trim();
  if (!workspaceId) throw new SpecialistInternalError('Verified token is missing workspace id', 'missing_workspace_id');
  return workspaceId;
};
const withWorkspaceMetadata = <T extends SupportedDelegationRequest>(request: T, workspaceId: string): T => ({ ...request, metadata: { ...(request.metadata ?? {}), workspaceId } });
const zodData = (error: unknown) => error instanceof Error ? { message: error.message } : undefined;
const normalizeError = (error: unknown) => {
  if (error instanceof RelayAuthError) { const relayError = error as Error & { statusCode?: number; code?: string }; return { status: relayError.statusCode ?? 401, error: relayError.message, code: relayError.code ?? 'relay_auth_error', rpcCode: -32603 }; }
  if (error instanceof ClientError) return { status: 400, error: error.message, code: error.code, rpcCode: -32602 };
  if (error instanceof SpecialistInternalError) return { status: 500, error: error.message, code: error.code, rpcCode: -32603 };
  if (error instanceof Error) return { status: 500, error: error.message, code: 'specialist_internal_error', rpcCode: -32603 };
  return { status: 500, error: 'Specialist execution failed', code: 'specialist_internal_error', rpcCode: -32603 };
};
