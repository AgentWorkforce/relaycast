import { Router, Response } from 'express';
import {
  requireAgentToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseIdempotencyKey, runIdempotent } from '../middleware/idempotency.js';
import * as groupDmEngine from '../engine/groupDm.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const groupDmRouter = Router();

// POST /v1/dm/group - create a group DM
groupDmRouter.post(
  '/dm/group',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { participants, name } = req.body;
      if (!participants || !Array.isArray(participants) || participants.length < 1) {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'participants array is required with at least 1 member' },
        });
        return;
      }

      const result = await groupDmEngine.createGroupDm(
        req.workspace!.id,
        req.agent!.id,
        { participants, name },
      );
      res.status(201).json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// POST /v1/dm/:conversation_id/messages - post to group DM
groupDmRouter.post(
  '/dm/:conversation_id/messages',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'text is required' },
        });
        return;
      }

      const { key: idempotencyKey, error: idempotencyError } = parseIdempotencyKey(req);
      if (idempotencyError) {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_idempotency_key', message: idempotencyError },
        });
        return;
      }

      const conversationId = req.params.conversation_id as string;
      const idempotent = await runIdempotent({
        workspaceId: req.workspace!.id,
        actorId: req.agent!.id,
        scope: `dm-group-message:${conversationId}`,
        key: idempotencyKey,
        status: 201,
        fingerprint: JSON.stringify({ conversationId, text }),
        operation: () =>
          groupDmEngine.postGroupMessage(
            req.workspace!.id,
            conversationId,
            req.agent!.id,
            { text },
          ),
      });

      if (idempotent.replayed) {
        res.setHeader('Idempotency-Replayed', 'true');
      }

      res.status(idempotent.status).json({ ok: true, data: idempotent.data });

      // Fire-and-forget event publishing only for fresh writes.
      if (!idempotent.replayed) {
        const eventData = { ...idempotent.data, from_name: req.agent!.name };
        publishEvent({ type: 'group_dm.received', workspace_id: req.workspace!.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
        deliverEvent(req.workspace!.id, 'group_dm.received', eventData).catch(() => {});
      }
    } catch (err: unknown) {
      if (!res.headersSent) {
        const error = err as Error & { code?: string; status?: number };
        res.status(error.status || 500).json({
          ok: false,
          error: { code: error.code || 'internal_error', message: error.message },
        });
      }
    }
  },
);

// POST /v1/dm/:conversation_id/participants - add participant
groupDmRouter.post(
  '/dm/:conversation_id/participants',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { agent } = req.body;
      if (!agent || typeof agent !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'agent name is required' },
        });
        return;
      }

      const conversationId = req.params.conversation_id as string;
      const result = await groupDmEngine.addParticipant(
        req.workspace!.id,
        conversationId,
        req.agent!.id,
        agent,
      );
      res.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/dm/:conversation_id/participants/:agent_name - remove participant (leave)
groupDmRouter.delete(
  '/dm/:conversation_id/participants/:agent_name',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const conversationId = req.params.conversation_id as string;
      await groupDmEngine.removeParticipant(
        req.workspace!.id,
        conversationId,
        req.agent!.id,
      );
      res.status(204).send();
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);
