import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.js';
import { createRequestLogger } from '../lib/logger.js';

type WaitUntilContext = {
  executionCtx?: {
    waitUntil: (promise: Promise<unknown>) => void;
  };
};

export const loggerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);

  const logger = createRequestLogger(c, 'request', { request_id: requestId });
  c.set('logger', logger);

  const startedAt = Date.now();
  await next();

  const durationMs = Date.now() - startedAt;
  const statusCode = c.res.status;

  if (statusCode >= 500) {
    logger.error('Request failed', {
      status_code: statusCode,
      duration_ms: durationMs,
    });
  } else if (statusCode >= 400) {
    logger.warn('Request client error', {
      status_code: statusCode,
      duration_ms: durationMs,
    });
  }

  const flushPromise = logger.flush();
  const executionCtx = (c as unknown as WaitUntilContext).executionCtx;
  if (executionCtx && typeof executionCtx.waitUntil === 'function') {
    executionCtx.waitUntil(flushPromise);
    return;
  }
  void flushPromise;
};
