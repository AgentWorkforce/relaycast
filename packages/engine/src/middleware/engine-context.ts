import { createMiddleware } from 'hono/factory';
import type { AppEnv, EngineRuntime } from '../env.js';

/**
 * Injects the deployment's {@link EngineRuntime} (ports + providers + config)
 * onto every request, plus the convenience `db` variable. Mounted first by
 * `createEngine`, so all downstream engine code reads infrastructure off
 * `c.get('engine')` / `c.get('db')` rather than Cloudflare `c.env` bindings.
 */
export function engineContext(runtime: EngineRuntime) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('engine', runtime);
    c.set('db', runtime.db);
    await next();
  });
}
