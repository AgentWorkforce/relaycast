import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as deliveryEngine from '../engine/delivery.js';
import { fanoutToAgents } from './fanout.js';
import { notifyDeliveryFailures } from './deliveryRouting.js';
import { runInBackground } from './background.js';
import { errorResponse } from '../lib/httpError.js';
import { ListDeliveriesQuerySchema, FailDeliveryRequestSchema, DeferDeliveryRequestSchema } from '@relaycast/types';

export const deliveryRoutes = new Hono<AppEnv>();

// GET /v1/deliveries - durable delivery queue for the calling agent.
// Defaults to non-terminal items (queued + delivered) so offline consumers
// can replay what they missed after reconnect.
deliveryRoutes.get(
  '/deliveries',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const parsed = ListDeliveriesQuerySchema.safeParse({
        status: c.req.query('status'),
        limit: c.req.query('limit'),
      });
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'Invalid status or limit' },
        }, 400);
      }
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const expired = await deliveryEngine.expireDueDeliveries(db, workspace.id);
      if (expired.length > 0) {
        runInBackground(c, notifyDeliveryFailures(c, expired), 'fanout delivery expired');
      }
      const result = await deliveryEngine.listDeliveries(db, workspace.id, agent!.id, parsed.data);
      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/deliveries/:id/ack - idempotently mark a delivery acked.
deliveryRoutes.post(
  '/deliveries/:id/ack',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const id = c.req.param('id');
      const result = await deliveryEngine.ackDelivery(db, workspace.id, agent!.id, id);
      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'delivery_not_found', message: 'Delivery not found' },
        }, 404);
      }
      // Only fan out when this call actually transitioned the delivery, so
      // idempotent retries don't emit duplicate notifications.
      if (result.changed) {
        runInBackground(
          c,
          fanoutToAgents(c, [agent!.id], 'delivery.delivered', {
            delivery_id: result.delivery.id,
            message_id: result.delivery.message_id,
          }),
          'fanout delivery.delivered',
        );
      }
      return c.json({ ok: true, data: result.delivery });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/deliveries/:id/fail - idempotently record a failed delivery.
deliveryRoutes.post(
  '/deliveries/:id/fail',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      // The fail body is optional (error/retryable), so an empty body is valid
      // and defaults to {}. But a non-empty malformed JSON body is a client
      // error and must 400 — don't silently coerce it and mutate state.
      const bodyText = await c.req.text();
      let raw: unknown = {};
      if (bodyText.trim().length > 0) {
        try {
          raw = JSON.parse(bodyText);
        } catch {
          return c.json({
            ok: false,
            error: { code: 'invalid_request', message: 'Invalid JSON body' },
          }, 400);
        }
      }
      const parsed = FailDeliveryRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'Invalid fail payload' },
        }, 400);
      }
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const id = c.req.param('id');
      const result = await deliveryEngine.failDelivery(db, workspace.id, agent!.id, id, parsed.data);
      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'delivery_not_found', message: 'Delivery not found' },
        }, 404);
      }
      if (result.changed) {
        runInBackground(
          c,
          fanoutToAgents(c, [agent!.id], 'delivery.failed', {
            delivery_id: result.delivery.id,
            message_id: result.delivery.message_id,
            error: result.delivery.error,
            retryable: result.delivery.retryable,
          }),
          'fanout delivery.failed',
        );
      }
      return c.json({ ok: true, data: result.delivery });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/deliveries/:id/defer - idempotently defer a delivery to available_at.
deliveryRoutes.post(
  '/deliveries/:id/defer',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const raw = await c.req.json().catch(() => null);
      const parsed = DeferDeliveryRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'available_at must be an ISO-8601 timestamp' },
        }, 400);
      }
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const id = c.req.param('id');
      const result = await deliveryEngine.deferDelivery(db, workspace.id, agent!.id, id, {
        availableAt: new Date(parsed.data.available_at),
        reason: parsed.data.reason,
      });
      if (!result) {
        return c.json({
          ok: false,
          error: { code: 'delivery_not_found', message: 'Delivery not found' },
        }, 404);
      }
      if (result.changed) {
        runInBackground(
          c,
          fanoutToAgents(c, [agent!.id], 'delivery.deferred', {
            delivery_id: result.delivery.id,
            message_id: result.delivery.message_id,
            available_at: result.delivery.available_at,
            reason: result.delivery.reason,
          }),
          'fanout delivery.deferred',
        );
      }
      return c.json({ ok: true, data: result.delivery });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
