import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as eventSubscriptionEngine from '../engine/eventSubscription.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const eventSubscriptionRoutes = new Hono<AppEnv>();

const createSubscriptionSchema = z.object({
  events: z.array(z.string()).min(1),
  filter: z.object({
    channel: z.string().optional(),
    mentions: z.string().optional(),
  }).nullable().optional(),
  url: z.string().min(1),
  secret: z.string().nullable().optional(),
});

// POST /v1/subscriptions - create an outbound event subscription
eventSubscriptionRoutes.post('/subscriptions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = createSubscriptionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const hasEventsIssue = parsed.error.issues.some((issue) => issue.path[0] === 'events');
      const hasUrlIssue = parsed.error.issues.some((issue) => issue.path[0] === 'url');
      const message = hasEventsIssue
        ? 'events array is required'
        : hasUrlIssue
          ? 'url is required'
          : 'invalid subscription body';
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message },
      }, 400);
    }
    const { events, filter, url, secret } = parsed.data;

    const result = await eventSubscriptionEngine.createSubscription(
      db,
      workspace.id,
      { events, filter, url, secret: secret ?? undefined },
    );
    emitServerEvent(c, workspace.id, 'relaycast_server_subscription_created', {
      subscription_id: result.id,
      event_count: result.events.length,
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});

// GET /v1/subscriptions - list subscriptions
eventSubscriptionRoutes.get('/subscriptions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await eventSubscriptionEngine.listSubscriptions(db, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
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
      return c.json({
        ok: false,
        error: { code: 'subscription_not_found', message: 'Subscription not found' },
      }, 404);
    }
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
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
      return c.json({
        ok: false,
        error: { code: 'subscription_not_found', message: 'Subscription not found' },
      }, 404);
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_subscription_deleted', {
      subscription_id: c.req.param('id'),
    });
    return c.body(null, 204);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as ContentfulStatusCode);
  }
});
