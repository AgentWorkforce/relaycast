import { Router, Response } from 'express';
import {
  requireAuth,
  requireAgentToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as channelEngine from '../engine/channel.js';
import { publishEvent } from '../ws/pubsub.js';
import { deliverEvent } from '../engine/eventDelivery.js';

export const channelRouter = Router();

function paramName(req: AuthenticatedRequest): string {
  return req.params.name as string;
}

// POST /v1/channels - create channel
channelRouter.post(
  '/channels',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, topic } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        });
        return;
      }

      const result = await channelEngine.createChannel(
        req.workspace!.id,
        { name, topic },
        req.agent?.id,
      );
      res.status(201).json({ ok: true, data: result });

      // Fire-and-forget event publishing
      const eventData = { ...result, channel_name: result.name };
      publishEvent({ type: 'channel.created', workspace_id: req.workspace!.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(req.workspace!.id, 'channel.created', eventData).catch(() => {});
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      const status = error.status || 500;
      res.status(status).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/channels - list channels
channelRouter.get(
  '/channels',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const includeArchived = req.query.include_archived === 'true';
      const channels = await channelEngine.listChannels(
        req.workspace!.id,
        includeArchived,
      );
      res.json({ ok: true, data: channels });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// GET /v1/channels/:name - get channel with members
channelRouter.get(
  '/channels/:name',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const channel = await channelEngine.getChannel(
        req.workspace!.id,
        paramName(req),
      );
      if (!channel) {
        res.status(404).json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${paramName(req)}" not found`,
          },
        });
        return;
      }
      res.json({ ok: true, data: channel });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// PATCH /v1/channels/:name - update channel
channelRouter.patch(
  '/channels/:name',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = await channelEngine.updateChannel(
        req.workspace!.id,
        paramName(req),
        req.body,
      );
      if (!updated) {
        res.status(404).json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${paramName(req)}" not found`,
          },
        });
        return;
      }
      res.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// PATCH /v1/channels/:name/topic - set channel topic
// Alias for PATCH /v1/channels/:name with { topic }, kept for backwards compatibility.
channelRouter.patch(
  '/channels/:name/topic',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { topic } = req.body ?? {};
      if (topic === undefined || typeof topic !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'topic is required' },
        });
        return;
      }

      const updated = await channelEngine.updateChannel(
        req.workspace!.id,
        paramName(req),
        { topic },
      );
      if (!updated) {
        res.status(404).json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${paramName(req)}" not found`,
          },
        });
        return;
      }
      res.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// DELETE /v1/channels/:name - archive channel (soft delete)
channelRouter.delete(
  '/channels/:name',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const archived = await channelEngine.archiveChannel(
        req.workspace!.id,
        paramName(req),
      );
      if (!archived) {
        res.status(404).json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${paramName(req)}" not found`,
          },
        });
        return;
      }
      res.status(204).send();

      // Fire-and-forget event publishing
      const eventData = { channel_name: paramName(req) };
      publishEvent({ type: 'channel.archived', workspace_id: req.workspace!.id, data: eventData, timestamp: new Date().toISOString() }).catch(() => {});
      deliverEvent(req.workspace!.id, 'channel.archived', eventData).catch(() => {});
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// POST /v1/channels/:name/join - agent joins channel (agent token required)
channelRouter.post(
  '/channels/:name/join',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await channelEngine.joinChannel(
        req.workspace!.id,
        paramName(req),
        req.agent!.id,
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

// POST /v1/channels/:name/leave - agent leaves channel (agent token required)
channelRouter.post(
  '/channels/:name/leave',
  requireAgentToken,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await channelEngine.leaveChannel(
        req.workspace!.id,
        paramName(req),
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

// GET /v1/channels/:name/members - list channel members
channelRouter.get(
  '/channels/:name/members',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const members = await channelEngine.getMembers(
        req.workspace!.id,
        paramName(req),
      );
      res.json({ ok: true, data: members });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      res.status(error.status || 500).json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      });
    }
  },
);

// POST /v1/channels/:name/invite - invite agent to channel
channelRouter.post(
  '/channels/:name/invite',
  requireAuth,
  rateLimit,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const agent =
        req.body?.agent ?? req.body?.agent_name ?? req.body?.agentName;
      if (!agent || typeof agent !== 'string') {
        res.status(400).json({
          ok: false,
          error: { code: 'invalid_request', message: 'agent is required' },
        });
        return;
      }

      // For invite, we need to know who's doing the inviting
      const inviterAgentId = req.agent?.id;
      if (!inviterAgentId) {
        res.status(403).json({
          ok: false,
          error: {
            code: 'agent_token_required',
            message: 'Agent token required to invite others',
          },
        });
        return;
      }

      const result = await channelEngine.inviteAgent(
        req.workspace!.id,
        paramName(req),
        inviterAgentId,
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
