import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { errorResponse } from '../lib/httpError.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as inboundWebhookEngine from '../engine/inboundWebhook.js';
import * as triggerEngine from '../engine/trigger.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import {
  jsonCreated,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

export const inboundWebhookRoutes = new Hono<AppEnv>();

const createInboundWebhookSchema = z.object({
  name: z.string().min(1).optional(),
  channel: z.string().min(1),
});

const triggerInboundWebhookSchema = z.object({
  text: z.string().optional(),
  message: z.string().optional(),
  source: z.string().optional(),
  author: z.string().optional(),
  payload: z.unknown().optional(),
}).passthrough();

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function hookUrl(requestUrl: string, webhookId: string): string {
  return new URL(`/v1/hooks/${webhookId}`, requestUrl).toString();
}

// POST /v1/webhooks - create an inbound webhook
inboundWebhookRoutes.post('/webhooks', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = await parseJsonBody(c, createInboundWebhookSchema, (failure) => {
      const hasChannelIssue = failure.error.issues.some((issue) => issue.path[0] === 'channel');
      return hasChannelIssue ? 'channel is required' : 'invalid webhook body';
    });
    if (!parsed.ok) {
      return parsed.response;
    }
    const { name, channel } = parsed.data;

    // Resolve channel name to ID
    const ch = await channelEngine.getChannel(db, workspace.id, channel);
    if (!ch) {
      return jsonNotFound(c, 'channel_not_found', `Channel "${channel}" not found`);
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
    return jsonCreated(c, { ...result, url: hookUrl(c.req.url, result.webhook_id) });
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
    return jsonOk(c, result.map((webhook) => ({ ...webhook, url: hookUrl(c.req.url, webhook.id) })));
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
      return jsonNotFound(c, 'webhook_not_found', 'Webhook not found');
    }
    emitServerEvent(c, workspace.id, 'relaycast_server_inbound_webhook_deleted', {
      webhook_id: c.req.param('id'),
    });
    return jsonNoContent(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /v1/hooks/:webhookId - trigger a webhook (external callers)
inboundWebhookRoutes.post('/hooks/:webhookId', async (c) => {
  try {
    const db = c.get('db');
    const token = extractBearerToken(c.req.header('Authorization'));
    const parsed = await parseJsonBody(c, triggerInboundWebhookSchema, 'invalid webhook payload');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { text, message, source, author, payload } = parsed.data;
    const result = await inboundWebhookEngine.triggerWebhook(
      db,
      c.req.param('webhookId'),
      token,
      {
        text: text ?? message,
        source,
        author: author ?? source,
        payload: (payload && typeof payload === 'object') ? payload as Record<string, unknown> : undefined,
      },
    );
    if (!result) {
      return jsonNotFound(c, 'webhook_not_found', 'Webhook not found or inactive');
    }
    const { workspace_id, channel_id, agent_id, ...responseData } = result;

    const eventData = { ...responseData, channel_id };
    if (channel_id) {
      runInBackground(
        c,
        fanoutToChannel(c, channel_id, 'webhook.received', eventData, workspace_id),
        'fanout webhook.received',
      );
    }
    runInBackground(
      c,
      (async () => {
        const { nodeConnections } = c.get('engine');
        await triggerEngine.fireMessageTriggers({
          db,
          nodeConnections,
          workspaceId: workspace_id,
          message: {
            id: String(result.message_id),
            channel_id,
            channel_name: result.channel,
            agent_id,
            text: result.text,
            mentions: [],
            metadata: result.metadata,
            created_at: result.created_at,
          },
        });
      })(),
      'fire message triggers',
    );
    await sendWebhookEvent(c, {
      type: 'webhook.received',
      workspaceId: workspace_id,
      data: eventData,
    });
    // Also emit message.created so writeback subscriptions (which filter on
    // message.created + channel) fire and can cache the relayfile VFS path for
    // later thread-reply routing. The metadata carries the relayfile path that
    // the forwarder embedded in the webhook payload.
    if (Object.keys(result.metadata).length > 0) {
      await sendWebhookEvent(c, {
        type: 'message.created',
        workspaceId: workspace_id,
        data: {
          id: result.message_id,
          channel: result.channel,
          channel_name: result.channel,
          channel_id,
          text: result.text,
          created_at: result.created_at,
          from_name: result.author,
          metadata: result.metadata,
        },
      });
    }
    emitServerEvent(c, workspace_id, 'relaycast_server_inbound_webhook_triggered', {
      webhook_id: result.webhook_id,
      message_id: result.message_id,
      channel_id,
      source: result.source ?? null,
      author: result.author ?? null,
    });

    return jsonCreated(c, responseData);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
