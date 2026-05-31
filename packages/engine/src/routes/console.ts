import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as consoleEngine from '../engine/console.js';
import { errorResponse } from '../lib/httpError.js';

export const consoleRoutes = new Hono<AppEnv>();

const listLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  channel_id: z.string().min(1).optional(),
  conversation_id: z.string().min(1).optional(),
  delivery_kind: z.enum(['channel', 'dm']).optional(),
});

const windowQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

const agentStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

consoleRoutes.get('/console/messages', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = listLogsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid console message query' },
      }, 400);
    }

    const data = await consoleEngine.listMessageLogs(db, workspace.id, {
      limit: parsed.data.limit,
      before: parsed.data.before,
      agentId: parsed.data.agent_id,
      channelId: parsed.data.channel_id,
      conversationId: parsed.data.conversation_id,
      deliveryKind: parsed.data.delivery_kind,
    });

    return c.json({ ok: true, data });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/stats', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = windowQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid console stats query' },
      }, 400);
    }

    const data = await consoleEngine.getConsoleOverview(db, workspace.id, parsed.data.days);
    return c.json({ ok: true, data });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/agents', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = agentStatsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid console agent query' },
      }, 400);
    }

    const data = await consoleEngine.getAgentStats(
      db,
      workspace.id,
      parsed.data.days,
      parsed.data.limit,
    );
    return c.json({ ok: true, data });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/costs', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = windowQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'Invalid console cost query' },
      }, 400);
    }

    const data = await consoleEngine.getCostStats(db, workspace.id, parsed.data.days);
    return c.json({ ok: true, data });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
