import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as searchEngine from '../engine/search.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonInvalidRequest, jsonOk, parseQueryParams } from '../lib/httpResponse.js';
import { PaginationQuerySchema } from '../lib/httpQuery.js';

export const searchRoutes = new Hono<AppEnv>();

const searchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().optional(),
  channel: z.string().optional(),
  from: z.string().optional(),
});

// GET /v1/search?q=...&channel=...&from=...&limit=...&before=...&after=...
searchRoutes.get(
  '/search',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = parseQueryParams(c, searchQuerySchema, 'Invalid search query');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { q, channel, from, limit, before, after } = parsed.data;
      if (!q || !q.trim()) {
        return jsonInvalidRequest(c, 'q (search query) is required');
      }

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

      return jsonOk(c, results);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
