import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as channelEngine from '../engine/channel.js';

export const channelRoutes = new Hono<AppEnv>();

// POST /v1/channels - create channel
channelRoutes.post(
  '/channels',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const { name, topic } = await c.req.json();
      if (!name || typeof name !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'name is required' },
        }, 400);
      }

      const result = await channelEngine.createChannel(
        db,
        workspace.id,
        { name, topic },
        agent?.id,
      );

      // TODO: DO fanout

      return c.json({ ok: true, data: result }, 201);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      const status = error.status || 500;
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, status as any);
    }
  },
);

// GET /v1/channels - list channels
channelRoutes.get(
  '/channels',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const includeArchived = c.req.query('include_archived') === 'true';
      const channels = await channelEngine.listChannels(
        db,
        workspace.id,
        includeArchived,
      );
      return c.json({ ok: true, data: channels });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/channels/:name - get channel with members
channelRoutes.get(
  '/channels/:name',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const channel = await channelEngine.getChannel(db, workspace.id, name);
      if (!channel) {
        return c.json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${name}" not found`,
          },
        }, 404);
      }
      return c.json({ ok: true, data: channel });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// PATCH /v1/channels/:name - update channel
channelRoutes.patch(
  '/channels/:name',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const body = await c.req.json();
      const updated = await channelEngine.updateChannel(
        db,
        workspace.id,
        name,
        body,
      );
      if (!updated) {
        return c.json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${name}" not found`,
          },
        }, 404);
      }

      // TODO: DO fanout

      return c.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// PATCH /v1/channels/:name/topic - set channel topic
// Alias for PATCH /v1/channels/:name with { topic }, kept for backwards compatibility.
channelRoutes.patch(
  '/channels/:name/topic',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const body = await c.req.json();
      const { topic } = body ?? {};
      if (topic === undefined || typeof topic !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'topic is required' },
        }, 400);
      }

      const updated = await channelEngine.updateChannel(
        db,
        workspace.id,
        name,
        { topic },
      );
      if (!updated) {
        return c.json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${name}" not found`,
          },
        }, 404);
      }

      // TODO: DO fanout

      return c.json({ ok: true, data: updated });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// DELETE /v1/channels/:name - archive channel (soft delete)
channelRoutes.delete(
  '/channels/:name',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const archived = await channelEngine.archiveChannel(
        db,
        workspace.id,
        name,
      );
      if (!archived) {
        return c.json({
          ok: false,
          error: {
            code: 'channel_not_found',
            message: `Channel "${name}" not found`,
          },
        }, 404);
      }

      // TODO: DO fanout

      return c.body(null, 204);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// POST /v1/channels/:name/join - agent joins channel (agent token required)
channelRoutes.post(
  '/channels/:name/join',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const name = c.req.param('name');
      const result = await channelEngine.joinChannel(
        db,
        workspace.id,
        name,
        agent!.id,
      );

      // TODO: DO fanout

      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// POST /v1/channels/:name/leave - agent leaves channel (agent token required)
channelRoutes.post(
  '/channels/:name/leave',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const name = c.req.param('name');
      await channelEngine.leaveChannel(
        db,
        workspace.id,
        name,
        agent!.id,
      );

      // TODO: DO fanout

      return c.body(null, 204);
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// GET /v1/channels/:name/members - list channel members
channelRoutes.get(
  '/channels/:name/members',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const members = await channelEngine.getMembers(
        db,
        workspace.id,
        name,
      );
      return c.json({ ok: true, data: members });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);

// POST /v1/channels/:name/invite - invite agent to channel
channelRoutes.post(
  '/channels/:name/invite',
  requireAuth,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const name = c.req.param('name');
      const body = await c.req.json();
      const agentName =
        body?.agent ?? body?.agent_name ?? body?.agentName;
      if (!agentName || typeof agentName !== 'string') {
        return c.json({
          ok: false,
          error: { code: 'invalid_request', message: 'agent is required' },
        }, 400);
      }

      // For invite, we need to know who's doing the inviting
      const inviterAgentId = agent?.id;
      if (!inviterAgentId) {
        return c.json({
          ok: false,
          error: {
            code: 'agent_token_required',
            message: 'Agent token required to invite others',
          },
        }, 403);
      }

      const result = await channelEngine.inviteAgent(
        db,
        workspace.id,
        name,
        inviterAgentId,
        agentName,
      );

      // TODO: DO fanout

      return c.json({ ok: true, data: result });
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return c.json({
        ok: false,
        error: { code: error.code || 'internal_error', message: error.message },
      }, (error.status || 500) as any);
    }
  },
);
