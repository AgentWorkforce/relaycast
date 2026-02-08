import { Router, Response } from 'express';
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as eventSubscriptionEngine from '../engine/eventSubscription.js';

export const eventSubscriptionRouter = Router();

// POST /v1/subscriptions - create an outbound event subscription
eventSubscriptionRouter.post(
  '/subscriptions',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { events, filter, url, secret } = req.body;
      if (!events || !Array.isArray(events) || events.length === 0) {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'events array is required' },
        });
        return;
      }
      if (!url || typeof url !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'url is required' },
        });
        return;
      }

      const result = await eventSubscriptionEngine.createSubscription(
        req.workspace!.id,
        { events, filter, url, secret },
      );
      res.status(201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/subscriptions - list subscriptions
eventSubscriptionRouter.get(
  '/subscriptions',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await eventSubscriptionEngine.listSubscriptions(
        req.workspace!.id,
      );
      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/subscriptions/:id - get a single subscription
eventSubscriptionRouter.get(
  '/subscriptions/:id',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await eventSubscriptionEngine.getSubscription(
        req.workspace!.id,
        req.params.id as string,
      );
      if (!result) {
        res.status(404).json({
          ok: false,
          error: { code: 'subscription_not_found', message: 'Subscription not found' },
        });
        return;
      }
      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/subscriptions/:id - delete a subscription
eventSubscriptionRouter.delete(
  '/subscriptions/:id',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await eventSubscriptionEngine.deleteSubscription(
        req.workspace!.id,
        req.params.id as string,
      );
      if (!deleted) {
        res.status(404).json({
          ok: false,
          error: { code: 'subscription_not_found', message: 'Subscription not found' },
        });
        return;
      }
      res.status(204).send();
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
