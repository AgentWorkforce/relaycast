import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';
import * as triggerEngine from '../engine/trigger.js';

export const triggerRoutes = new Hono<AppEnv>();

const triggerBodySchema = z.object({
  channel: z.string().nullable().optional(),
  pattern: z.string().nullable().optional(),
  mention: z.boolean().nullable().optional(),
  action_name: z.string().min(1),
  enabled: z.boolean().optional(),
});

const updateTriggerBodySchema = triggerBodySchema.partial();

// POST /v1/triggers
triggerRoutes.post('/triggers', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, triggerBodySchema, 'invalid trigger body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const result = await triggerEngine.createTrigger(c.get('db'), c.get('workspace').id, parsed.data);
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/triggers
triggerRoutes.get('/triggers', requireAuth, rateLimit, async (c) => {
  try {
    const result = await triggerEngine.listTriggers(c.get('db'), c.get('workspace').id);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/triggers/:id
triggerRoutes.get('/triggers/:id', requireAuth, rateLimit, async (c) => {
  try {
    const result = await triggerEngine.getTrigger(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!result) {
      return jsonNotFound(c, 'trigger_not_found', 'Trigger not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// PATCH /v1/triggers/:id
triggerRoutes.patch('/triggers/:id', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, updateTriggerBodySchema, 'invalid trigger body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const result = await triggerEngine.updateTrigger(c.get('db'), c.get('workspace').id, c.req.param('id'), parsed.data);
    if (!result) {
      return jsonNotFound(c, 'trigger_not_found', 'Trigger not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/triggers/:id
triggerRoutes.delete('/triggers/:id', requireAuth, rateLimit, async (c) => {
  try {
    const deleted = await triggerEngine.deleteTrigger(c.get('db'), c.get('workspace').id, c.req.param('id'));
    if (!deleted) {
      return jsonNotFound(c, 'trigger_not_found', 'Trigger not found');
    }
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
