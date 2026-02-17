import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as reactionEngine from '../engine/reaction.js';

export const reactionRoutes = new Hono<AppEnv>();

// POST /v1/messages/:id/reactions - add reaction (idempotent)
reactionRoutes.post(
  '/messages/:id/reactions',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const { emoji } = await c.req.json();
      if (!emoji || typeof emoji !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'emoji is required' },
        }, 400);
      }

      const result = await reactionEngine.addReaction(
        db,
        workspace.id,
        c.req.param('id'),
        agent!.id,
        emoji,
      );
      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

      // Strip internal channel_id/channel_name before sending to client
      const { channel_id, channel_name, ...reactionData } = result;

      // TODO: DO fanout

      return c.json({ ok: true, data: reactionData }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// DELETE /v1/messages/:id/reactions/:emoji - remove own reaction
reactionRoutes.delete(
  '/messages/:id/reactions/:emoji',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const result = await reactionEngine.removeReaction(
        db,
        workspace.id,
        c.req.param('id'),
        agent?.id ?? '',
        c.req.param('emoji'),
      );
      if (result === null) {
        return c.json({
          ok: false,
          error: { code: 'message_not_found', message: 'Message not found' },
        }, 404);
      }

      // TODO: DO fanout

      return c.body(null, 204);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/messages/:id/reactions - aggregated reactions
reactionRoutes.get(
  '/messages/:id/reactions',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const result = await reactionEngine.getReactions(
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
