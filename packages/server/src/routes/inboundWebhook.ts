import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboundWebhookEngine from '../engine/inboundWebhook.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel } from './fanout.js';

export const inboundWebhookRoutes = new Hono<AppEnv>();

// POST /v1/webhooks - create an inbound webhook
inboundWebhookRoutes.post('/webhooks', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const { name, channel } = await c.req.json();

    if (!name || typeof name !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'name is required' },
      }, 400);
    }
    if (!channel || typeof channel !== 'string') {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'channel is required' },
      }, 400);
    }

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
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
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
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
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
    return c.body(null, 204);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// POST /v1/hooks/:webhookId - trigger a webhook (external callers)
inboundWebhookRoutes.post('/hooks/:webhookId', async (c) => {
  try {
    const db = c.get('db');
    const body = await c.req.json();
    const { text, source, payload } = body || {};
    const result = await inboundWebhookEngine.triggerWebhook(
      db,
      c.req.param('webhookId'),
      { text, source, payload },
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
      fanoutToChannel(c, channel_id, 'webhook.received', eventData).catch(() => {});
    }
    c.env.WEBHOOK_QUEUE.send({
      type: 'webhook.received',
      workspaceId: workspace_id,
      data: eventData,
    });

    return c.json({ ok: true, data: responseData }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
