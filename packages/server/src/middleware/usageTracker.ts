import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

export const usageTracker = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (workspace) {
    // Fire-and-forget KV increment
    const key = `usage:${workspace.id}:api_calls`;
    c.env.KV.get(key).then(val => {
      const count = parseInt(val || '0', 10) + 1;
      c.env.KV.put(key, String(count)).catch(() => {});
    }).catch(() => {});
  }
  await next();
});
