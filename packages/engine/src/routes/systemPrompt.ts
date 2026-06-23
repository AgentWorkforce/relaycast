import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as systemPromptEngine from '../engine/systemPrompt.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonInvalidRequest, jsonOk, parseJsonBody } from '../lib/httpResponse.js';

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
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

systemPromptRoutes.put('/workspace/system-prompt', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, updateSystemPromptSchema, 'invalid system prompt body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { prompt, reset } = parsed.data;

    if (reset === true || prompt === null) {
      const result = await systemPromptEngine.setSystemPrompt(db, workspace.id, null);
      emitServerEvent(c, workspace.id, 'relaycast_server_system_prompt_updated', {
        operation: 'reset',
      });
      return jsonOk(c, result);
    }

    if (!prompt || typeof prompt !== 'string') {
      return jsonInvalidRequest(c, 'prompt must be a non-empty string');
    }

    const result = await systemPromptEngine.setSystemPrompt(db, workspace.id, prompt);
    emitServerEvent(c, workspace.id, 'relaycast_server_system_prompt_updated', {
      operation: 'set',
    });
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
