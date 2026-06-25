import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as searchEngine from '../engine/search.js';
import {
  filterObserverSearchResults,
  getObserverTokenFromContext,
} from '../engine/observerToken.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonOk, parseQueryParams } from '../lib/httpResponse.js';
import { PaginationQuerySchema } from '../lib/httpQuery.js';

export const searchRoutes = new Hono<AppEnv>();

const searchQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().min(1),
  channel: z.string().optional(),
  from: z.string().optional(),
});

// GET /v1/search?q=...&channel=...&from=...&limit=...&before=...&after=...
searchRoutes.get(
  '/search',
  requireWorkspaceRead('search:read'),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const parsed = parseQueryParams(c, searchQuerySchema, (failure) =>
        failure.error.issues.some((issue) => issue.path[0] === 'q')
          ? 'q (search query) is required'
          : 'Invalid search query',
      );
      if (!parsed.ok) {
        return parsed.response;
      }
      const { q, channel, from, limit, before, after } = parsed.data;

      const results = await searchEngine.searchMessages(db, workspace.id, {
        q,
        channel,
        from,
        limit,
        before,
        after,
      });
      const visibleResults = await filterObserverSearchResults(
        db,
        workspace.id,
        getObserverTokenFromContext(c),
        results,
      );
      const responseResults = visibleResults.map(({
        agent_id: _agentId,
        channel_type: _channelType,
        ...result
      }) => result);

      emitServerEvent(c, workspace.id, 'relaycast_server_search_executed', {
        query_length: q.trim().length,
        result_count: responseResults.length,
        has_channel_filter: Boolean(channel),
        has_from_filter: Boolean(from),
      });

      return jsonOk(c, responseResults);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
