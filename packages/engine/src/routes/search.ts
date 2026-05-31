import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as searchEngine from '../engine/search.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const searchRoutes = new Hono<AppEnv>();

// GET /v1/search?q=...&channel=...&from=...&limit=...&before=...&after=...
searchRoutes.get(
  '/search',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const q = c.req.query('q');
      if (!q || typeof q !== 'string' || !q.trim()) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'q (search query) is required' },
        }, 400);
      }

      const channel = c.req.query('channel');
      const from = c.req.query('from');
      const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
      const before = c.req.query('before');
      const after = c.req.query('after');

      const results = await searchEngine.searchMessages(db, workspace.id, {
        q,
        channel,
        from,
        limit,
        before,
        after,
      });

      emitServerEvent(c, workspace.id, 'relaycast_server_search_executed', {
        query_length: q.trim().length,
        result_count: results.length,
        has_channel_filter: Boolean(channel),
        has_from_filter: Boolean(from),
      });

      return c.json({ ok: true, data: results });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as ContentfulStatusCode);
    }
  },
);
