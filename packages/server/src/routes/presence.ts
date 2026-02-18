import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as presenceEngine from '../engine/presence.js';

export const presenceRoutes = new Hono<AppEnv>();

presenceRoutes.get('/agents/presence', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await presenceEngine.getPresence(db, c.env.PRESENCE_DO, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// POST /agents/disconnect — explicit disconnect (works around local DO hibernation issues)
presenceRoutes.post('/agents/disconnect', requireAgentToken, rateLimit, async (c) => {
  try {
    const agent = c.get('agent')!;
    const workspace = c.get('workspace');
    const doId = c.env.PRESENCE_DO.idFromName(workspace.id);
    const stub = c.env.PRESENCE_DO.get(doId);
    await stub.fetch(new Request('http://do/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, workspaceId: workspace.id }),
    }));
    return c.json({ ok: true });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
