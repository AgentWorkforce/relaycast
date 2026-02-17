import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

export const presenceRefresh = createMiddleware<AppEnv>(async (c, next) => {
  try {
    const agent = c.get('agent');
    const workspace = c.get('workspace');
    if (agent && workspace) {
      const doId = c.env.PRESENCE_DO.idFromName(workspace.id);
      const stub = c.env.PRESENCE_DO.get(doId);
      // Fire-and-forget heartbeat
      stub.fetch(new Request('http://do/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ agentId: agent.id, workspaceId: workspace.id }),
      })).catch(() => {});
    }
  } catch {
    // Don't block the request if presence refresh fails
  }
  await next();
});
