import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env.js';
import { createLogger } from '../logger.js';

/**
 * Middleware that creates a logger instance and adds it to the context.
 * Also logs request completion with timing information.
 */
export const loggerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const logger = createLogger(c.env);
  c.set('logger', logger);

  const start = Date.now();
  const requestId = crypto.randomUUID();

  await next();

  const durationMs = Date.now() - start;
  const statusCode = c.res.status;

  // Log request completion
  if (statusCode >= 500) {
    logger.error('Request failed', undefined, {
      requestId,
      route: c.req.path,
      method: c.req.method,
      statusCode,
      durationMs,
    });
  } else if (statusCode >= 400) {
    logger.warn('Request client error', {
      requestId,
      route: c.req.path,
      method: c.req.method,
      statusCode,
      durationMs,
    });
  }

  // Flush logs to PostHog asynchronously (don't block response)
  c.executionCtx.waitUntil(logger.flush());
};
