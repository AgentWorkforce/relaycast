import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as eventSubscriptionEngine from '../engine/eventSubscription.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

export const eventSubscriptionRoutes = new Hono<AppEnv>();

const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const headerValueSchema = z.string().refine((value) => !/[\r\n]/.test(value), 'header values cannot contain CR/LF');

const createSubscriptionSchema = z.object({
  events: z.array(z.string()).min(1),
  filter: z.object({
    channel: z.string().optional(),
    mentions: z.string().optional(),
  }).nullable().optional(),
  url: z.string().min(1),
  headers: z.record(headerNameSchema, headerValueSchema).optional(),
  secret: z.string().nullable().optional(),
});

// POST /v1/subscriptions - create an outbound event subscription
eventSubscriptionRoutes.post('/subscriptions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, createSubscriptionSchema, (failure) => {
      const issues = failure.error?.issues ?? [];
      const hasEventsIssue = issues.some((issue) => issue.path[0] === 'events');
      const hasUrlIssue = issues.some((issue) => issue.path[0] === 'url');
      return hasEventsIssue
        ? 'events array is required'
        : hasUrlIssue
          ? 'url is required'
          : 'invalid subscription body';
    });
    if (!parsed.ok) {
      return parsed.response;
    }
    const { events, filter, url, headers, secret } = parsed.data;

    const result = await eventSubscriptionEngine.createSubscription(
      db,
      workspace.id,
      { events, filter, url, headers, secret: secret ?? undefined },
    );
    emitServerEvent(c, workspace.id, 'relaycast_server_subscription_created', {
      subscription_id: result.id,
      event_count: result.events.length,
    });
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/subscriptions - list subscriptions
eventSubscriptionRoutes.get('/subscriptions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await eventSubscriptionEngine.listSubscriptions(db, workspace.id);
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/subscriptions/:id - get a single subscription
eventSubscriptionRoutes.get('/subscriptions/:id', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await eventSubscriptionEngine.getSubscription(
      db,
      workspace.id,
      c.req.param('id'),
    );
    if (!result) {
      return jsonNotFound(c, 'subscription_not_found', 'Subscription not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/subscriptions/:id - delete a subscription
eventSubscriptionRoutes.delete('/subscriptions/:id', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const deleted = await eventSubscriptionEngine.deleteSubscription(
      db,
      workspace.id,
      c.req.param('id'),
    );
    if (!deleted) {
      return jsonNotFound(c, 'subscription_not_found', 'Subscription not found');
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_subscription_deleted', {
      subscription_id: c.req.param('id'),
    });
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
