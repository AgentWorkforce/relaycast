import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as dmEngine from '../engine/dm.js';
import { and, eq, isNull } from 'drizzle-orm';
import { dmParticipants } from '../db/schema.js';
import { fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';

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
      const parsed = sendDmSchema.safeParse(await c.req.json());
      if (!parsed.success) {
        const hasToIssue = parsed.error.issues.some((issue) => issue.path[0] === 'to');
        const hasTextIssue = parsed.error.issues.some((issue) => issue.path[0] === 'text');
        const message = hasToIssue
          ? '"to" agent name is required'
          : hasTextIssue
            ? 'text is required'
            : 'invalid dm body';
        return c.json({
          ok: false,
          error: {
            code: 'invalid_request',
            message,
          },
        }, 400);
      }
      const { to, text, attachments, mode } = parsed.data;
      const normalizedAttachments = attachments && attachments.length > 0 ? attachments : undefined;

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(c.req.header('Idempotency-Key'));
      if (idempotencyError) {
        return c.json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        }, 400);
      }

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
        }),
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      if (!idempotent.replayed) {
        const { _delivery, ...publicDmData } = idempotent.data as typeof idempotent.data & { _delivery?: { id: string; agentId: string } | null };
        try {
          const rows = await db
            .select({ agentId: dmParticipants.agentId })
            .from(dmParticipants)
            .where(
              and(
                eq(dmParticipants.conversationId, publicDmData.conversation_id),
                isNull(dmParticipants.leftAt),
              ),
            );
          const eventData = { ...publicDmData, from_name: agent!.name };
          runInBackground(c, fanoutToAgents(c, rows.map((r) => r.agentId), 'dm.received', eventData), 'fanout dm.received');
        } catch {
          // Ignore fanout failures
        }

        // Emit delivery.accepted directly to the recipient's AgentDO
        if (_delivery) {
          runInBackground(
            c,
            fanoutToAgents(c, [_delivery.agentId], 'delivery.accepted', {
              delivery_id: _delivery.id,
              message_id: String(publicDmData.id),
              reason: 'dm',
            }),
            'fanout delivery.accepted',
          );
        }

        await sendWebhookEvent(c, {
          type: 'dm.received',
          workspaceId: workspace.id,
          data: { ...publicDmData, from_name: agent!.name },
        });
        emitServerEvent(c, workspace.id, 'relaycast_server_dm_sent', {
          conversation_id: publicDmData.conversation_id,
          message_id: publicDmData.id,
          from_agent_id: agent!.id,
          to_agent_name: to,
        });
      }

      const { _delivery: _drop, ...responseData } = idempotent.data as typeof idempotent.data & { _delivery?: unknown };
      return c.json({ ok: true, data: responseData }, idempotent.status as ContentfulStatusCode);
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
      return c.json({ ok: true, data: conversations });
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
      const limit = c.req.query('limit')
        ? parseInt(c.req.query('limit')!, 10)
        : undefined;
      const before = c.req.query('before');
      const after = c.req.query('after');

      const conversationId = c.req.param('conversation_id');
      const msgs = await dmEngine.getDmMessages(
        db,
        workspace.id,
        conversationId,
        agent!.id,
        { limit, before, after },
      );
      return c.json({ ok: true, data: msgs });
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
