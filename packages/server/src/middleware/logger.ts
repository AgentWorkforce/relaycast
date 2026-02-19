import crypto from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.js';
import { createRequestLogger } from '../lib/logger.js';

type WaitUntilContext = {
  executionCtx?: {
    waitUntil: (promise: Promise<unknown>) => void;
  };
};

function getExecutionCtx(c: unknown): WaitUntilContext['executionCtx'] | undefined {
  try {
    const executionCtx = (c as WaitUntilContext).executionCtx;
    if (executionCtx && typeof executionCtx.waitUntil === 'function') return executionCtx;
  } catch {
    // Hono's test context can throw when executionCtx is accessed.
  }
  return undefined;
}

const EXPECTED_NOISE_WINDOW_MS = 60_000;
const MAX_NOISE_BUCKETS = 500;

type ErrorInfo = {
  error_code?: string;
  error_reason?: string;
};

type NoiseBucket = {
  window_start_ms: number;
  suppressed_count: number;
  exemplar_fields: Record<string, unknown>;
};

const expectedClientNoiseBuckets = new Map<string, NoiseBucket>();

function sanitizeReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function pruneNoiseBuckets(): void {
  if (expectedClientNoiseBuckets.size <= MAX_NOISE_BUCKETS) return;
  const oldestKey = expectedClientNoiseBuckets.keys().next().value as string | undefined;
  if (oldestKey) expectedClientNoiseBuckets.delete(oldestKey);
}

function recordExpectedClientNoise(
  logger: ReturnType<typeof createRequestLogger>,
  key: string,
  fields: Record<string, unknown>,
): void {
  const now = Date.now();
  let bucket = expectedClientNoiseBuckets.get(key);

  if (!bucket) {
    bucket = {
      window_start_ms: now,
      suppressed_count: 0,
      exemplar_fields: fields,
    };
    expectedClientNoiseBuckets.set(key, bucket);
    pruneNoiseBuckets();
  } else if (now - bucket.window_start_ms >= EXPECTED_NOISE_WINDOW_MS) {
    logger.info('Expected client errors suppressed (summary)', {
      ...bucket.exemplar_fields,
      noise_window_ms: EXPECTED_NOISE_WINDOW_MS,
      suppressed_count: bucket.suppressed_count,
    });
    bucket.window_start_ms = now;
    bucket.suppressed_count = 0;
    bucket.exemplar_fields = fields;
  }

  bucket.suppressed_count += 1;
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const [scheme, rawToken] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !rawToken) return undefined;
  return rawToken;
}

function tokenType(token: string): 'agent' | 'workspace' | 'unknown' {
  if (token.startsWith('at_live_')) return 'agent';
  if (token.startsWith('rk_live_')) return 'workspace';
  return 'unknown';
}

function hashIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function routeGroupForPath(path: string): string {
  if (path === '/v1/ws') return 'ws';
  if (path === '/mcp') return 'mcp';
  if (path.startsWith('/v1/')) return 'api_v1';
  if (path.startsWith('/.well-known/')) return 'well_known';
  if (path.startsWith('/health')) return 'health';
  return 'other';
}

function deriveClientName(headers: Headers): string | undefined {
  const explicit = headers.get('x-client-name') ?? headers.get('x-relaycast-client');
  if (explicit) return explicit.trim().slice(0, 80);
  const ua = headers.get('user-agent');
  if (!ua) return undefined;
  const family = ua.split(/[\/\s;]/)[0];
  return family ? family.trim().slice(0, 80) : undefined;
}

function classifyAuthScheme(authHeader: string | undefined, queryToken: string | undefined): string {
  if (authHeader) {
    const bearerToken = parseBearerToken(authHeader);
    if (!bearerToken) return 'authorization_other';
    const type = tokenType(bearerToken);
    if (type === 'agent') return 'bearer_agent_token';
    if (type === 'workspace') return 'bearer_workspace_key';
    return 'bearer_unknown';
  }

  if (queryToken) {
    const type = tokenType(queryToken);
    if (type === 'agent') return 'query_agent_token';
    if (type === 'workspace') return 'query_workspace_key';
    return 'query_unknown';
  }

  return 'none';
}

async function extractErrorInfo(response: Response): Promise<ErrorInfo> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) return {};

  try {
    const body = await response.clone().json() as unknown;
    if (!body || typeof body !== 'object') return {};
    const maybeError = (body as { error?: unknown }).error;
    if (!maybeError || typeof maybeError !== 'object') return {};

    const code = (maybeError as { code?: unknown }).code;
    const message = (maybeError as { message?: unknown }).message;
    return {
      ...(typeof code === 'string' ? { error_code: code } : {}),
      ...(typeof message === 'string' ? { error_reason: sanitizeReason(message) } : {}),
    };
  } catch {
    return {};
  }
}

function statusClass(statusCode: number): string {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

export function isExpectedClientNoise(route: string, statusCode: number, errorCode?: string): boolean {
  if (
    route === '/v1/ws'
    && statusCode === 401
    && (errorCode === undefined || errorCode === 'unauthorized' || errorCode === 'invalid_token')
  ) {
    return true;
  }

  if (route === '/mcp' && (statusCode === 400 || statusCode === 406)) {
    return true;
  }

  return false;
}

export function resetExpectedClientNoiseBucketsForTest(): void {
  expectedClientNoiseBuckets.clear();
}

export const loggerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);

  const logger = createRequestLogger(c, 'request', { request_id: requestId });
  c.set('logger', logger);

  const startedAt = Date.now();
  await next();

  const durationMs = Date.now() - startedAt;
  const statusCode = c.res.status;
  const requestHeaders = c.req.raw.headers;
  const authHeader = requestHeaders.get('authorization') ?? undefined;
  const queryToken = c.req.query('token');
  const bearerToken = parseBearerToken(authHeader);
  const presentedToken = bearerToken ?? queryToken;
  const authScheme = classifyAuthScheme(authHeader, queryToken);
  const clientName = deriveClientName(requestHeaders);
  const contentType = requestHeaders.get('content-type');
  const accept = requestHeaders.get('accept');
  const connectingIp = requestHeaders.get('cf-connecting-ip');
  const userAgent = requestHeaders.get('user-agent');
  const errorInfo = statusCode >= 400 ? await extractErrorInfo(c.res) : {};

  const metadata: Record<string, unknown> = {
    status_code: statusCode,
    status_class: statusClass(statusCode),
    duration_ms: durationMs,
    route_group: routeGroupForPath(c.req.path),
    auth_scheme: authScheme,
    ...(contentType ? { content_type: contentType } : {}),
    ...(accept ? { accept } : {}),
    ...(clientName ? { client_name: clientName } : {}),
    ...(presentedToken ? { actor_fingerprint: hashIdentifier(presentedToken) } : {}),
    ...(connectingIp ? { ip_hash: hashIdentifier(connectingIp) } : {}),
    ...(userAgent ? { ua_hash: hashIdentifier(userAgent) } : {}),
    ...errorInfo,
  };

  if (statusCode >= 500) {
    logger.error('Request failed', metadata);
  } else if (statusCode >= 400) {
    const expectedNoise = isExpectedClientNoise(
      c.req.path,
      statusCode,
      typeof errorInfo.error_code === 'string' ? errorInfo.error_code : undefined,
    );

    if (expectedNoise) {
      const noiseKey = [
        c.req.method,
        c.req.path,
        statusCode,
        errorInfo.error_code ?? 'none',
        authScheme,
      ].join('|');

      recordExpectedClientNoise(logger, noiseKey, metadata);
    } else {
      logger.warn('Request client error', metadata);
    }
  }

  const flushPromise = logger.flush();
  const executionCtx = getExecutionCtx(c);
  if (executionCtx) {
    executionCtx.waitUntil(flushPromise);
    return;
  }
  void flushPromise;
};
