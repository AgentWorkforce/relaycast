import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { UpdateSubscriptionRequestSchema } from '@relaycast/types';
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
  jsonInvalidRequest,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

export const eventSubscriptionRoutes = new Hono<AppEnv>();

const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const headerValueSchema = z.string().refine((value) => !/[\r\n]/.test(value), 'header values cannot contain CR/LF');

const subscriptionFieldsSchema = z.object({
  events: z.array(z.string()).min(1),
  filter: z.object({
    channel: z.string().optional(),
    mentions: z.string().optional(),
    recipients: z.array(z.string().min(1)).min(1).max(500).optional(),
  }).nullable().optional(),
  url: z.string().min(1),
  headers: z.record(headerNameSchema, headerValueSchema).optional(),
  secret: z.string().nullable().optional(),
  signature_scheme: z.enum(['legacy', 'standard-webhooks']).default('legacy'),
});

/** standard-webhooks needs a whsec_ secret; checked against the resulting row. */
function hasValidSignatureSecret(scheme: string, secret: string | null | undefined): boolean {
  return scheme !== 'standard-webhooks' || (!!secret && isValidStandardWebhookSecret(secret));
}

const SIGNATURE_SECRET_MESSAGE = 'standard-webhooks requires a whsec_ secret that decodes to 24-64 bytes';

const createSubscriptionSchema = subscriptionFieldsSchema.superRefine((value, ctx) => {
  if (!hasValidSignatureSecret(value.signature_scheme, value.secret)) {
    ctx.addIssue({ code: 'custom', path: ['secret'], message: SIGNATURE_SECRET_MESSAGE });
  }
});

const updateSubscriptionSchema = UpdateSubscriptionRequestSchema;

function isSafeSubscriptionUrl(c: Context<AppEnv>, url: string): boolean {
  const strict = c.get('engine').config?.environment !== 'test';
  return isSafeExternalUrl(url, { strict, requireHttps: strict });
}

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
    if (!isSafeSubscriptionUrl(c, url)) {
      return jsonError(c, 'unsafe_subscription_url', 'Subscription URL must use HTTPS and resolve publicly', 400);
    }

    const result = await eventSubscriptionEngine.createSubscription(
      db,
      workspace.id,
      { events, filter, url, headers, secret: secret ?? undefined, signatureScheme: signature_scheme },
    );
    emitServerEvent(c, workspace.id, 'subscription.created', {
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

// PATCH /v1/subscriptions/:id - partially update a subscription
eventSubscriptionRoutes.patch('/subscriptions/:id', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, updateSubscriptionSchema, (failure) => {
      const issues = failure.error.issues;
      return issues.some((issue) => issue.path.length === 0 && issue.code === 'custom')
        ? 'at least one field is required'
        : 'invalid subscription body';
    });
    if (!parsed.ok) {
      return parsed.response;
    }
    const update = parsed.data;
    if (update.url !== undefined && !isSafeSubscriptionUrl(c, update.url)) {
      return jsonError(c, 'unsafe_subscription_url', 'Subscription URL must use HTTPS and resolve publicly', 400);
    }

    const current = await eventSubscriptionEngine.getSubscriptionRow(db, workspace.id, c.req.param('id'));
    if (!current) {
      return jsonNotFound(c, 'subscription_not_found', 'Subscription not found');
    }
    // Stored headers (often credentials) are redacted on read; a caller that
    // moves the URL must restate them, or they would go to the new endpoint.
    const urlChanges = update.url !== undefined && update.url !== current.url;
    if (urlChanges && update.headers === undefined && eventSubscriptionEngine.hasStoredHeaders(current.headers)) {
      return jsonError(
        c,
        'subscription_headers_required',
        'Changing url on a subscription with stored headers requires headers in the same request (a new map, or {} or null to clear them)',
        400,
      );
    }
    const scheme = update.signature_scheme ?? current.signatureScheme;
    const secret = update.secret !== undefined ? update.secret : current.secret;
    if (!hasValidSignatureSecret(scheme, secret)) {
      return jsonInvalidRequest(c, SIGNATURE_SECRET_MESSAGE);
    }

    const result = await eventSubscriptionEngine.updateSubscription(db, workspace.id, current.id, {
      events: update.events,
      filter: update.filter,
      url: update.url,
      headers: update.headers,
      secret: update.secret,
      signatureScheme: update.signature_scheme,
      isActive: update.is_active,
    }, {
      signatureScheme: current.signatureScheme,
      secret: current.secret,
      // A url without headers is valid only for the url and headers read above.
      ...(update.url !== undefined && update.headers === undefined
        ? { url: current.url, noHeaders: urlChanges }
        : {}),
    });
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
    emitServerEvent(c, workspace.id, 'subscription.deleted', {
      subscription_id: c.req.param('id'),
    });
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
