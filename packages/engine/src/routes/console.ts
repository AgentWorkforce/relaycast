import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as consoleEngine from '../engine/console.js';
import {
  filterObserverSearchResults,
  getObserverTokenFromContext,
} from '../engine/observerToken.js';
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

async function visibleMessageLogsForObserver(
  db: Parameters<typeof consoleEngine.listMessageLogsForWindow>[0],
  workspaceId: string,
  days: number,
  observer: ReturnType<typeof getObserverTokenFromContext>,
) {
  const logs = await consoleEngine.listMessageLogsForWindow(db, workspaceId, days);
  return filterObserverSearchResults(
    db,
    workspaceId,
    observer,
    logs,
    { eventTypes: consoleMessageLogEventTypes },
  );
}

function consoleMessageLogEventTypes(
  log: { conversation_id?: string | null; channel_type?: number | null },
): string[] {
  if (!log.conversation_id) return ['message.created'];
  // channel_type 2 = group DM, 1 = 1:1 DM. Classify by the log's real type so an
  // observer filtering on only one DM event type does not see the other.
  return log.channel_type === 2 ? ['group_dm.received'] : ['dm.received'];
}

consoleRoutes.get('/console/messages', requireWorkspaceRead('messages:read'), rateLimit, async (c) => {
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

    const visible = await filterObserverSearchResults(
      db,
      workspace.id,
      getObserverTokenFromContext(c),
      data.map((item) => ({
        ...item,
        channel_name: item.channel_name ?? undefined,
      })),
      { eventTypes: consoleMessageLogEventTypes },
    );

    const response = visible.map(({ channel_type: _channelType, ...item }) => item);
    return jsonOk(c, response);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/stats', requireWorkspaceRead('activity:read'), rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, windowQuerySchema, 'Invalid console stats query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const days = parsed.data.days ?? 7;
    const observer = getObserverTokenFromContext(c);
    const data = observer
      ? consoleEngine.summarizeConsoleOverview(
        await visibleMessageLogsForObserver(db, workspace.id, days, observer),
        days,
      )
      : await consoleEngine.getConsoleOverview(db, workspace.id, days);
    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/agents', requireWorkspaceRead('agents:read'), rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, agentStatsQuerySchema, 'Invalid console agent query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const days = parsed.data.days ?? 7;
    const limit = parsed.data.limit ?? 20;
    const observer = getObserverTokenFromContext(c);
    const data = observer
      ? consoleEngine.summarizeAgentStats(
        await visibleMessageLogsForObserver(db, workspace.id, days, observer),
        limit,
      )
      : await consoleEngine.getAgentStats(
        db,
        workspace.id,
        days,
        limit,
      );
    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

consoleRoutes.get('/console/costs', requireWorkspaceRead('activity:read'), rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const db = c.get('db');
    const parsed = parseQueryParams(c, windowQuerySchema, 'Invalid console cost query');
    if (!parsed.ok) {
      return parsed.response;
    }

    const days = parsed.data.days ?? 7;
    const observer = getObserverTokenFromContext(c);
    const data = observer
      ? consoleEngine.summarizeCostStats(
        await visibleMessageLogsForObserver(db, workspace.id, days, observer),
        days,
      )
      : await consoleEngine.getCostStats(db, workspace.id, days);
    return jsonOk(c, data);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
