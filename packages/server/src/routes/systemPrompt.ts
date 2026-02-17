import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as systemPromptEngine from '../engine/systemPrompt.js';

export const systemPromptRoutes = new Hono<AppEnv>();

systemPromptRoutes.get('/workspace/system-prompt', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await systemPromptEngine.getSystemPrompt(db, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

systemPromptRoutes.put('/workspace/system-prompt', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const { prompt, reset } = await c.req.json();

    if (reset === true || prompt === null) {
      const result = await systemPromptEngine.setSystemPrompt(db, workspace.id, null);
      return c.json({ ok: true, data: result });
    }

    if (!prompt || typeof prompt !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'prompt must be a non-empty string' },
      }, 400);
    }

    const result = await systemPromptEngine.setSystemPrompt(db, workspace.id, prompt);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
