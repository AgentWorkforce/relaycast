import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as systemPromptEngine from '../engine/systemPrompt.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const systemPromptRoutes = new Hono<AppEnv>();

const updateSystemPromptSchema = z.object({
  prompt: z.unknown().optional(),
  reset: z.boolean().optional(),
}).passthrough();

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
    const parsed = updateSystemPromptSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'invalid system prompt body' },
      }, 400);
    }
    const { prompt, reset } = parsed.data;

    if (reset === true || prompt === null) {
      const result = await systemPromptEngine.setSystemPrompt(db, workspace.id, null);
      emitServerEvent(c, workspace.id, 'relaycast_server_system_prompt_updated', {
        operation: 'reset',
      });
      return c.json({ ok: true, data: result });
    }

    if (!prompt || typeof prompt !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'prompt must be a non-empty string' },
      }, 400);
    }

    const result = await systemPromptEngine.setSystemPrompt(db, workspace.id, prompt);
    emitServerEvent(c, workspace.id, 'relaycast_server_system_prompt_updated', {
      operation: 'set',
    });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
