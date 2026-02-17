import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as billingEngine from '../engine/billing.js';

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.post('/billing/subscribe', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const { plan, payment_method } = await c.req.json() as { plan?: unknown; payment_method?: unknown };

    if (plan !== 'pro' && plan !== 'enterprise') {
      return c.json({ ok: false, error: { code: 'invalid_request', message: "plan must be 'pro' or 'enterprise'" } }, 400);
    }
    if (!payment_method || typeof payment_method !== 'string') {
      return c.json({ ok: false, error: { code: 'invalid_request', message: 'payment_method is required' } }, 400);
    }

    const result = await billingEngine.subscribe(db, workspace.id, plan, payment_method);
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

billingRoutes.get('/billing/subscription', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const result = await billingEngine.getSubscription(c.env.KV, workspace.id, workspace.plan, workspace.stripeSubscriptionId || null);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

billingRoutes.get('/billing/usage', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const rawPeriod = c.req.query('period') || 'current';

    if (rawPeriod !== 'current' && rawPeriod !== 'previous') {
      return c.json({ ok: false, error: { code: 'invalid_request', message: "period must be 'current' or 'previous'" } }, 400);
    }

    const result = await billingEngine.getUsage(c.env.KV, workspace.id, rawPeriod);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

billingRoutes.get('/billing/invoices', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const rawLimit = c.req.query('limit');
    let limit = 10;

    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return c.json({ ok: false, error: { code: 'invalid_request', message: 'limit must be a positive integer' } }, 400);
      }
      limit = parsed;
    }

    const result = await billingEngine.getInvoices(workspace.stripeCustomerId || null, limit);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});

billingRoutes.post('/billing/portal', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const result = await billingEngine.createPortalSession(workspace.stripeCustomerId || null);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
  }
});
