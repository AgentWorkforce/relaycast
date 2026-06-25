import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import { incrementUsage } from '../engine/usage.js';

export const usageTracker = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (workspace) {
    // Fire-and-forget atomic usage increment via the key/value port.
    incrementUsage(c.get('engine').kv, workspace.id, 'api_calls').catch(() => {});
  }
  await next();
});
