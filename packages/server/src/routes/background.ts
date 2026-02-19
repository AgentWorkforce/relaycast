import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';

type WaitUntilContext = {
  executionCtx?: {
    waitUntil: (promise: Promise<unknown>) => void;
  };
};

/**
 * Run async work in the request background lifecycle.
 * In Cloudflare Workers this uses waitUntil; elsewhere it degrades to best-effort.
 *
 * Why this exists:
 * Route handlers trigger fanout + queue work that should continue after the HTTP
 * response is returned. Plain "fire-and-forget" promises can be terminated at
 * request end in Workers, which leads to dropped realtime events.
 */
export function runInBackground(
  c: Context<AppEnv>,
  task: Promise<unknown> | unknown,
  label: string,
): void {
  const logger = getRequestLogger(c, 'background.task');
  const wrapped = Promise.resolve(task).catch(async (error) => {
    logger.error(`${label} failed`, {
      ...toErrorDetails(error),
    });
    await logger.flush();
  });

  let executionCtx: WaitUntilContext['executionCtx'];
  try {
    executionCtx = (c as unknown as WaitUntilContext).executionCtx;
  } catch {
    executionCtx = undefined;
  }

  if (executionCtx && typeof executionCtx.waitUntil === 'function') {
    executionCtx.waitUntil(wrapped);
    return;
  }

  // Non-Workers runtimes/tests: still execute best-effort.
  void wrapped;
}
