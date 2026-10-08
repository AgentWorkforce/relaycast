import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as eventSubscriptionEngine from '../engine/eventSubscription.js';
import {
  listWebhookDeliveries,
  replayWebhookDelivery,
} from '../engine/eventDelivery.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { isValidStandardWebhookSecret } from '../lib/standardWebhook.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import {
  jsonCreated,
  jsonError,
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
  signature_scheme: z.enum(['legacy', 'standard-webhooks']).default('legacy'),
}).superRefine((value, ctx) => {
  if (
    value.signature_scheme === 'standard-webhooks'
    && (!value.secret || !isValidStandardWebhookSecret(value.secret))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['secret'],
      message: 'standard-webhooks requires a whsec_ secret that decodes to 24-64 bytes',
    });
  }
});

// POST /v1/subscriptions - create an outbound event subscription
eventSubscriptionRoutes.post('/subscriptions', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, createSubscriptionSchema, (failure) => {
      const issues = failure.error.issues;
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
    const { events, filter, url, headers, secret, signature_scheme } = parsed.data;
    const strict = c.get('engine').config?.environment !== 'test';
    if (!isSafeExternalUrl(url, { strict, requireHttps: strict })) {
      return jsonError(c, 'unsafe_subscription_url', 'Subscription URL must use HTTPS and resolve publicly', 400);
    }

    const result = await eventSubscriptionEngine.createSubscription(
      db,
      workspace.id,
      { events, filter, url, headers, secret: secret ?? undefined, signatureScheme: signature_scheme },
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

// GET /v1/subscriptions/:id/deliveries - inspect delivery health / dead letters
eventSubscriptionRoutes.get('/subscriptions/:id/deliveries', requireAuth, rateLimit, async (c) => {
  try {
    const status = z.enum(['pending', 'succeeded', 'failed', 'dead_letter'])
      .optional()
      .safeParse(c.req.query('status'));
    const limit = z.coerce.number().int().min(1).max(100).default(50)
      .safeParse(c.req.query('limit'));
    if (!status.success || !limit.success) {
      return jsonError(c, 'invalid_delivery_query', 'Invalid delivery status or limit', 400);
    }

    const db = c.get('db');
    const workspace = c.get('workspace');
    const subscription = await eventSubscriptionEngine.getSubscription(
      db,
      workspace.id,
      c.req.param('id'),
    );
    if (!subscription) {
      return jsonNotFound(c, 'subscription_not_found', 'Subscription not found');
    }
    return jsonOk(c, await listWebhookDeliveries(db, workspace.id, subscription.id, {
      status: status.data,
      limit: limit.data,
    }));
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /v1/subscriptions/:id/deliveries/:delivery_id/replay - replay one dead letter
eventSubscriptionRoutes.post(
  '/subscriptions/:id/deliveries/:delivery_id/replay',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const workspace = c.get('workspace');
      const result = await replayWebhookDelivery(
        c.get('db'),
        workspace.id,
        c.req.param('id'),
        c.req.param('delivery_id'),
      );
      if (result.kind === 'not_found') {
        return jsonNotFound(c, 'webhook_delivery_not_found', 'Webhook delivery not found');
      }
      if (result.kind === 'not_replayable') {
        return jsonError(
          c,
          'webhook_delivery_not_replayable',
          `Webhook delivery in ${result.status} state cannot be replayed`,
          409,
        );
      }

      await c.get('engine').webhookQueue.send(result.event);
      return jsonOk(c, { id: c.req.param('delivery_id'), status: 'pending' });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

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
