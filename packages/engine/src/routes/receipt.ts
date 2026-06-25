import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as receiptEngine from '../engine/receipt.js';
import { and, eq } from 'drizzle-orm';
import { messages } from '../db/schema.js';
import { fanoutToChannel } from './fanout.js';
import { sendNodeDeliveriesForChannel } from '../engine/nodeDeliver.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonNotFound, jsonOk } from '../lib/httpResponse.js';

export const receiptRoutes = new Hono<AppEnv>();

// POST /v1/messages/:id/read - Mark message as read
receiptRoutes.post(
  '/messages/:id/read',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const result = await receiptEngine.markRead(
        db,
        workspace.id,
        c.req.param('id'),
        agent!.id,
      );
      if (!result) {
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }

      const eventData = { ...result, agent_name: agent!.name };
      try {
        const [row] = await db
          .select({ channelId: messages.channelId })
          .from(messages)
          .where(and(eq(messages.id, c.req.param('id')), eq(messages.workspaceId, workspace.id)));
        if (row?.channelId) {
          runInBackground(c, fanoutToChannel(c, row.channelId, 'message.read', eventData), 'fanout message.read');
          runInBackground(
            c,
            sendNodeDeliveriesForChannel(
              {
                db,
                nodeConnections: c.get('engine').nodeConnections,
                workspaceId: workspace.id,
              },
              {
                channelId: row.channelId,
                messageId: result.message_id,
                event: 'message.read',
                eventKey: `${result.message_id}:${result.agent_id}:${result.read_at}`,
                data: eventData,
              },
            ),
            'node deliver message.read',
          );
        }
      } catch {
        // Ignore fanout failures
      }

      await sendWebhookEvent(c, {
        type: 'message.read',
        workspaceId: workspace.id,
        data: eventData,
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_message_read_marked', {
        message_id: result.message_id,
        agent_id: result.agent_id,
      });

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/messages/:id/readers - List agents who read
receiptRoutes.get(
  '/messages/:id/readers',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const result = await receiptEngine.getReaders(
        db,
        workspace.id,
        c.req.param('id'),
      );
      if (result === null) {
        return jsonNotFound(c, 'message_not_found', 'Message not found');
      }

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/channels/:name/read-status - Per-member read positions
receiptRoutes.get(
  '/channels/:name/read-status',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const result = await receiptEngine.getReadStatus(
        db,
        workspace.id,
        c.req.param('name'),
      );
      if (result === null) {
        return jsonNotFound(c, 'channel_not_found', 'Channel not found');
      }

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
