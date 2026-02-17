import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as threadEngine from '../engine/thread.js';

export const threadRoutes = new Hono<AppEnv>();

// POST /v1/messages/:id/replies - post a reply
threadRoutes.post(
  '/messages/:id/replies',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const { text } = await c.req.json();
      if (!text || typeof text !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        }, 400);
      }

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return c.json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        }, 400);
      }

      const agentId = agent?.id;
      if (!agentId) {
        return c.json({
          ok: false,
          error: { code: 'agent_token_required', message: 'Agent token required to post replies' },
        }, 403);
      }

      const parentId = c.req.param('id');
      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agentId,
        scope: `thread-reply:${parentId}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ parentId, text }),
        kv: c.env.KV,
        operation: () =>
          threadEngine.postReply(
            db,
            workspace.id,
            parentId,
            agentId,
            { text },
          ),
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      // TODO: DO fanout

      return c.json({ ok: true, data: idempotent.data }, idempotent.status as any);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/messages/:id/replies - get thread
threadRoutes.get(
  '/messages/:id/replies',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
      const before = c.req.query('before');
      const after = c.req.query('after');

      const parentId = c.req.param('id');
      const result = await threadEngine.getThread(
        db,
        workspace.id,
        parentId,
        { limit, before, after },
      );
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
