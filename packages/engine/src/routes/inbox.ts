import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboxEngine from '../engine/inbox.js';

export const inboxRoutes = new Hono<AppEnv>();

// GET /v1/inbox - unified inbox for the calling agent
inboxRoutes.get(
  '/inbox',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const result = await inboxEngine.getInbox(db, workspace.id, agent!.id);
      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);
