import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as dmEngine from '../engine/dm.js';
import { and, eq, isNull } from 'drizzle-orm';
import { dmParticipants } from '../db/schema.js';
import { fanoutToAgents } from './fanout.js';
import { runInBackground } from './background.js';

export const dmRoutes = new Hono<AppEnv>();

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
      const { to, text } = await c.req.json();
      if (!to || typeof to !== 'string') {
        return c.json({
          ok: false,
          error: {
            code: 'invalid_request',
            message: '"to" agent name is required',
          },
        }, 400);
      }
      if (!text || typeof text !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        }, 400);
      }

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
        fingerprint: JSON.stringify({ to, text }),
        kv: c.env.KV,
        operation: () => dmEngine.sendDm(db, workspace.id, agent!.id, { to, text }),
      });

      if (idempotent.replayed) {
        c.header('Idempotency-Replayed', 'true');
      }

      if (!idempotent.replayed) {
        try {
          const rows = await db
            .select({ agentId: dmParticipants.agentId })
            .from(dmParticipants)
            .where(
              and(
                eq(dmParticipants.conversationId, idempotent.data.conversation_id),
                isNull(dmParticipants.leftAt),
              ),
            );
          const eventData = { ...idempotent.data, from_name: agent!.name };
          runInBackground(c, fanoutToAgents(c, rows.map((r) => r.agentId), 'dm.received', eventData), 'fanout dm.received');
        } catch {
          // Ignore fanout failures
        }

        runInBackground(
          c,
          c.env.WEBHOOK_QUEUE.send({
            type: 'dm.received',
            workspaceId: workspace.id,
            data: { ...idempotent.data, from_name: agent!.name },
          }),
          'queue dm.received',
        );
      }

      return c.json({ ok: true, data: idempotent.data }, idempotent.status as any);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
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
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
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
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);
