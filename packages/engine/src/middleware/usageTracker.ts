import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

export const usageTracker = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (workspace) {
    // Fire-and-forget atomic usage increment via the key/value port.
    c.get('engine').kv.increment(`usage:${workspace.id}:api_calls`, 1).catch(() => {});
  }
  await next();
});
