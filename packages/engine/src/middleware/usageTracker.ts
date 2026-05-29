import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

export const usageTracker = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (workspace) {
    // Fire-and-forget usage increment via the key/value port
    const kv = c.get('engine').kv;
    const key = `usage:${workspace.id}:api_calls`;
    kv.get(key).then(val => {
      const count = parseInt(val || '0', 10) + 1;
      kv.put(key, String(count)).catch(() => {});
    }).catch(() => {});
  }
  await next();
});
