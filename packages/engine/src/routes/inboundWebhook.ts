import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { errorResponse } from '../lib/httpError.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboundWebhookEngine from '../engine/inboundWebhook.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel } from './fanout.js';
import { runInBackground } from './background.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const inboundWebhookRoutes = new Hono<AppEnv>();

const createInboundWebhookSchema = z.object({
  name: z.string().min(1),
  channel: z.string().min(1),
});

const triggerInboundWebhookSchema = z.object({
  text: z.string().optional(),
  source: z.string().optional(),
  payload: z.unknown().optional(),
}).passthrough();

// POST /v1/webhooks - create an inbound webhook
inboundWebhookRoutes.post('/webhooks', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = createInboundWebhookSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const hasNameIssue = parsed.error.issues.some((issue) => issue.path[0] === 'name');
      const hasChannelIssue = parsed.error.issues.some((issue) => issue.path[0] === 'channel');
      const message = hasNameIssue
        ? 'name is required'
        : hasChannelIssue
          ? 'channel is required'
          : 'invalid webhook body';
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message },
      }, 400);
    }
    const { name, channel } = parsed.data;

    // Resolve channel name to ID
    const ch = await channelEngine.getChannel(db, workspace.id, channel);
    if (!ch) {
      return c.json({
        ok: false,
        error: { code: 'channel_not_found', message: `Channel "${channel}" not found` },
      }, 404);
    }

    const result = await inboundWebhookEngine.createWebhook(
      db,
      workspace.id,
      ch.id,
      { name },
    );
    emitServerEvent(c, workspace.id, 'relaycast_server_inbound_webhook_created', {
      webhook_id: result.webhook_id,
      channel_name: channel,
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/webhooks - list webhooks
inboundWebhookRoutes.get('/webhooks', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await inboundWebhookEngine.listWebhooks(db, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/webhooks/:id - delete a webhook
inboundWebhookRoutes.delete('/webhooks/:id', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const deleted = await inboundWebhookEngine.deleteWebhook(
      db,
      workspace.id,
      c.req.param('id'),
    );
    if (!deleted) {
      return c.json({
        ok: false,
        error: { code: 'webhook_not_found', message: 'Webhook not found' },
      }, 404);
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_inbound_webhook_deleted', {
      webhook_id: c.req.param('id'),
    });
    return c.body(null, 204);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /v1/hooks/:webhookId - trigger a webhook (external callers)
inboundWebhookRoutes.post('/hooks/:webhookId', async (c) => {
  try {
    const db = c.get('db');
    const parsed = triggerInboundWebhookSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'invalid webhook payload' },
      }, 400);
    }
    const { text, source, payload } = parsed.data;
    const result = await inboundWebhookEngine.triggerWebhook(
      db,
      c.req.param('webhookId'),
      { text, source, payload: (payload && typeof payload === 'object') ? payload as Record<string, unknown> : undefined },
    );
    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'webhook_not_found', message: 'Webhook not found or inactive' },
      }, 404);
    }
    const { workspace_id, channel_id, ...responseData } = result;

    const eventData = { ...responseData, channel_id };
    if (channel_id) {
      runInBackground(
        c,
        fanoutToChannel(c, channel_id, 'webhook.received', eventData, undefined, workspace_id),
        'fanout webhook.received',
      );
    }
    runInBackground(
      c,
      c.get('engine').webhookQueue.send({
        type: 'webhook.received',
        workspaceId: workspace_id,
        data: eventData,
      }),
      'queue webhook.received',
    );
    emitServerEvent(c, workspace_id, 'relaycast_server_inbound_webhook_triggered', {
      webhook_id: result.webhook_id,
      message_id: result.message_id,
      channel_id,
      source: source ?? null,
    });

    return c.json({ ok: true, data: responseData }, 201);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
