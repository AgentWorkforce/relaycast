import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as receiptEngine from '../engine/receipt.js';
import { and, eq } from 'drizzle-orm';
import { messages } from '../db/schema.js';
import { fanoutToChannel } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

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

      const eventData = { ...result, agent_name: agent!.name };
      try {
        const [row] = await db
          .select({ channelId: messages.channelId })
          .from(messages)
          .where(and(eq(messages.id, c.req.param('id')), eq(messages.workspaceId, workspace.id)));
        if (row?.channelId) {
          runInBackground(c, fanoutToChannel(c, row.channelId, 'message.read', eventData), 'fanout message.read');
        }
      } catch {
        // Ignore fanout failures
      }

      runInBackground(
        c,
        c.env.WEBHOOK_QUEUE.send({
          type: 'message.read',
          workspaceId: workspace.id,
          data: eventData,
        }),
        'queue message.read',
      );
      emitServerEvent(c, workspace.id, 'relaycast_server_message_read_marked', {
        message_id: result.message_id,
        agent_id: result.agent_id,
      });

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
