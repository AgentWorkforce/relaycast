import { Router, Response } from 'express';
import { requireWorkspaceKey, type AuthenticatedRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as billingEngine from '../engine/billing.js';

export const billingRouter = Router();

billingRouter.post('/billing/subscribe', requireWorkspaceKey, rateLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { plan, payment_method } = req.body as { plan?: unknown; payment_method?: unknown };
    if (plan !== 'pro' && plan !== 'enterprise') { res.status(400).json({ ok: false, error: { code: 'invalid_request', message: "plan must be 'pro' or 'enterprise'" } }); return; }
    if (!payment_method || typeof payment_method !== 'string') { res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'payment_method is required' } }); return; }
    const result = await billingEngine.subscribe(req.workspace!.id, plan, payment_method);
    res.status(201).json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } });
  }
});

billingRouter.get('/billing/subscription', requireWorkspaceKey, rateLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await billingEngine.getSubscription(req.workspace!.id, req.workspace!.plan, req.workspace!.stripeSubscriptionId || null);
    res.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } });
  }
});

billingRouter.get('/billing/usage', requireWorkspaceKey, rateLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawPeriod = (req.query.period as string | undefined) || 'current';
    if (rawPeriod !== 'current' && rawPeriod !== 'previous') { res.status(400).json({ ok: false, error: { code: 'invalid_request', message: "period must be 'current' or 'previous'" } }); return; }
    const result = await billingEngine.getUsage(req.workspace!.id, rawPeriod);
    res.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } });
  }
});

billingRouter.get('/billing/invoices', requireWorkspaceKey, rateLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawLimit = req.query.limit as string | undefined;
    let limit = 10;
    if (rawLimit !== undefined) { const parsed = parseInt(rawLimit, 10); if (!Number.isFinite(parsed) || parsed <= 0) { res.status(400).json({ ok: false, error: { code: 'invalid_request', message: 'limit must be a positive integer' } }); return; } limit = parsed; }
    const result = await billingEngine.getInvoices(req.workspace!.stripeCustomerId || null, limit);
    res.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } });
  }
});

billingRouter.post('/billing/portal', requireWorkspaceKey, rateLimit, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await billingEngine.createPortalSession(req.workspace!.stripeCustomerId || null);
    res.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } });
  }
});
