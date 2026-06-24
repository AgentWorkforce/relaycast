import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as consoleEngine from '../engine/console.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonOk, parseQueryParams } from '../lib/httpResponse.js';
import { positiveIntQueryParam } from '../lib/httpQuery.js';

export const consoleRoutes = new Hono<AppEnv>();

const listLogsQuerySchema = z.object({
  limit: positiveIntQueryParam({ max: 100 }),
  before: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  channel_id: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  delivery_kind: z.enum(['channel', 'dm']).optional(),
});

const windowQuerySchema = z.object({
  days: positiveIntQueryParam({ defaultValue: 7, max: 30 }),
});

const agentStatsQuerySchema = z.object({
  days: positiveIntQueryParam({ defaultValue: 7, max: 30 }),
  limit: positiveIntQueryParam({ defaultValue: 20, max: 100 }),
});

consoleRoutes.get('/console/messages', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, listLogsQuerySchema, 'Invalid console message query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const data = await consoleEngine.listMessageLogs(db, workspace.id, {
      limit: parsed.data.limit,
      before: parsed.data.before,
      agentId: parsed.data.agent_id,
      channelId: parsed.data.channel_id,
      conversationId: parsed.data.conversation_id,
      deliveryKind: parsed.data.delivery_kind,
    });

    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/stats', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, windowQuerySchema, 'Invalid console stats query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const data = await consoleEngine.getConsoleOverview(db, workspace.id, parsed.data.days);
    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/agents', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, agentStatsQuerySchema, 'Invalid console agent query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const data = await consoleEngine.getAgentStats(
      db,
      workspace.id,
      parsed.data.days,
      parsed.data.limit,
    );
    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/costs', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, windowQuerySchema, 'Invalid console cost query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const data = await consoleEngine.getCostStats(db, workspace.id, parsed.data.days);
    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
