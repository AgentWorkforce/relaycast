import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireSender, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as leadersEngine from '../engine/leaders.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonInvalidRequest, jsonOk, parseJsonBody } from '../lib/httpResponse.js';

export const leadersRoutes = new Hono<AppEnv>();

const updateLeadersSchema = z.object({
  patterns: z.unknown().optional(),
  reset: z.boolean().optional(),
}).passthrough();

// GET accepts a workspace key, agent token or node token; PUT requires the workspace key.
leadersRoutes.get('/workspace/leaders', requireSender, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await leadersEngine.getWorkspaceLeaders(db, workspace.id);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

leadersRoutes.put('/workspace/leaders', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, updateLeadersSchema, 'invalid leaders body', {
      malformedBodyError: { code: 'invalid_request', message: 'Malformed JSON in request body' },
    });
    if (!parsed.ok) {
      return parsed.response;
    }
    const { patterns, reset } = parsed.data;

    let normalized: string[];
    if (reset === true) {
      if (patterns !== undefined) {
        return jsonInvalidRequest(c, 'reset cannot be combined with patterns');
      }
      normalized = [];
    } else {
      if (patterns === undefined) {
        return jsonInvalidRequest(c, 'patterns is required (or pass reset: true)');
      }
      const validation = leadersEngine.normalizeLeaderPatterns(patterns);
      if (!validation.ok) {
        return jsonInvalidRequest(c, validation.message);
      }
      normalized = validation.patterns;
    }

    const result = await leadersEngine.setWorkspaceLeaders(db, workspace.id, normalized);
    emitServerEvent(c, workspace.id, 'workspace.leaders.updated', {
      pattern_count: normalized.length,
    });
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
