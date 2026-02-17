import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as receiptEngine from '../engine/receipt.js';

export const receiptRoutes = new Hono<AppEnv>();

// POST /v1/messages/:id/read - Mark message as read
receiptRoutes.post(
  '/messages/:id/read',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const result = await receiptEngine.markRead(
        db,
        workspace.id,
        c.req.param('id'),
        agent!.id,
      );
      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

      // TODO: DO fanout

      return c.json({ ok: true, data: result }, 200);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/messages/:id/readers - List agents who read
receiptRoutes.get(
  '/messages/:id/readers',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const result = await receiptEngine.getReaders(
        db,
        workspace.id,
        c.req.param('id'),
      );
      if (result === null) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

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

// GET /v1/channels/:name/read-status - Per-member read positions
receiptRoutes.get(
  '/channels/:name/read-status',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const result = await receiptEngine.getReadStatus(
        db,
        workspace.id,
        c.req.param('name'),
      );
      if (result === null) {
        return c.json({
          ok: false,
          error: { code: 'channel_not_found', message: 'Channel not found' },
        }, 404);
      }

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
