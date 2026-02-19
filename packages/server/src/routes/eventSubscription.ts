import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as eventSubscriptionEngine from '../engine/eventSubscription.js';

export const eventSubscriptionRoutes = new Hono<AppEnv>();

// POST /v1/subscriptions - create an outbound event subscription
eventSubscriptionRoutes.post('/subscriptions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const { events, filter, url, secret } = await c.req.json();

    if (!events || !Array.isArray(events) || events.length === 0) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'events array is required' },
      }, 400);
    }
    if (!url || typeof url !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'url is required' },
      }, 400);
    }

    const result = await eventSubscriptionEngine.createSubscription(
      db,
      workspace.id,
      { events, filter, url, secret },
    );
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
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
    }, (error.status || 500) as any);
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
    }, (error.status || 500) as any);
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
    return c.body(null, 204);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
