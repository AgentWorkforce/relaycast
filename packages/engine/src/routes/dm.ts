import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { jsonIdempotentOk, parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as dmEngine from '../engine/dm.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { publishWorkspaceEvent } from './fanout.js';
import { notifyDeliveryRejections, routeDeliveryOutcomes } from './deliveryRouting.js';
import { buildDmReceivedEventData } from '../engine/deliveryWire.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonError, jsonOk, parseJsonBody } from '../lib/httpResponse.js';
import { parsePaginationQuery } from '../lib/httpQuery.js';

export const dmRoutes = new Hono<AppEnv>();

const sendDmSchema = z.object({
  to: z.string().min(1),
  text: z.string().min(1),
  attachments: z.array(z.string()).optional(),
  mode: z.enum(['wait', 'steer']).default('wait'),
});

// POST /v1/dm - send a DM
dmRoutes.post(
  '/dm',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const parsed = await parseJsonBody(c, sendDmSchema, (failure) => {
        const hasToIssue = failure.error.issues.some((issue) => issue.path[0] === 'to');
        const hasTextIssue = failure.error.issues.some((issue) => issue.path[0] === 'text');
        return hasToIssue
          ? '"to" agent name is required'
          : hasTextIssue
            ? 'text is required'
            : 'invalid dm body';
      });
      if (!parsed.ok) {
        return parsed.response;
      }
      const { to, text, attachments, mode } = parsed.data;
      const normalizedAttachments = attachments && attachments.length > 0 ? attachments : undefined;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return jsonError(c, 'invalid_idempotency_key', idempotencyError, 400);
      }

      const mailbox = resolveMailboxConfig(c.get('engine').config, workspace.id);
      const toDmReceivedEventData = (data: Awaited<ReturnType<typeof dmEngine.sendDm>>) => buildDmReceivedEventData(data, {
        fromName: agent!.name,
      });

      const idempotent = await runIdempotent({
        workspaceId: workspace.id,
        actorId: agent!.id,
        scope: 'dm:direct',
        key: idempotencyKey,
        status: 201,
        // Backward compatibility: historical fingerprint excluded mode (equivalent to wait).
        // Only include mode when explicit steer is requested.
        fingerprint: mode === 'steer'
          ? JSON.stringify({ to, text, ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}), mode })
          : JSON.stringify({ to, text, ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}) }),
        kv: c.get('engine').kv,
        operation: () => dmEngine.sendDm(db, workspace.id, agent!.id, {
          to,
          text,
          attachments: normalizedAttachments,
          mode,
        }, { mailbox }),
        afterOperation: async (data) => {
          await sendWebhookEvent(c, {
            type: 'dm.received',
            workspaceId: workspace.id,
            data: toDmReceivedEventData(data),
          });
        },
      });

      if (!idempotent.replayed) {
        const {
          _delivery,
          _delivery_rejections,
          ...publicDmData
        } = idempotent.data as typeof idempotent.data & {
          _delivery?: Parameters<typeof routeDeliveryOutcomes>[1][number] | null;
          _delivery_rejections?: Parameters<typeof notifyDeliveryRejections>[2];
        };
        const eventData = toDmReceivedEventData(idempotent.data);
        runInBackground(c, publishWorkspaceEvent(c, 'dm.received', eventData), 'publish dm.received');

        if (_delivery) {
          runInBackground(
            c,
            routeDeliveryOutcomes(c, [_delivery], 'dm.received', eventData),
            'route dm delivery',
          );
        }
        if (_delivery_rejections && _delivery_rejections.length > 0) {
          runInBackground(
            c,
            notifyDeliveryRejections(c, agent!.id, _delivery_rejections),
            'fanout delivery rejected',
          );
        }

        emitServerEvent(c, workspace.id, 'relaycast_server_dm_sent', {
          conversation_id: publicDmData.conversation_id,
          message_id: publicDmData.id,
          from_agent_id: agent!.id,
          to_agent_name: to,
        });
      }

      return jsonIdempotentOk(c, idempotent);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/dm/conversations - list DM conversations
dmRoutes.get(
  '/dm/conversations',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const conversations = await dmEngine.listConversations(
        db,
        workspace.id,
        agent!.id,
      );
      return jsonOk(c, conversations);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/dm/:conversation_id/messages - get DM messages
dmRoutes.get(
  '/dm/:conversation_id/messages',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const query = parsePaginationQuery(c);
      if (!query.ok) {
        return query.response;
      }
      const { limit, before, after } = query.data;

      const conversationId = c.req.param('conversation_id');
      const msgs = await dmEngine.getDmMessages(
        db,
        workspace.id,
        conversationId,
        agent!.id,
        { limit, before, after },
      );
      return jsonOk(c, msgs);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
