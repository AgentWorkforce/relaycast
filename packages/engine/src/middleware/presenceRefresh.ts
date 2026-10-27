import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

export const presenceRefresh = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const agent = c.get('agent');
    const workspace = c.get('workspace');
    if (agent && workspace) {
      // Fire-and-forget heartbeat via the presence port
      c.get('engine').presence
        .heartbeat(workspace.id, agent.id, agent.name)
        .catch(() => {});
    }
  } catch {
    // Don't block the request if presence refresh fails
  }
  await next();
});
