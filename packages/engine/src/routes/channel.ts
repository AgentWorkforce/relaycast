import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken, requireWorkspaceRead } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as channelEngine from '../engine/channel.js';
import { fanoutToChannel, fanoutToWorkspace, updateChannelMembers, updateChannelMuted } from './fanout.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  getChannelObserverResource,
  getObserverTokenFromContext,
  observerAllowsChannel,
  type ObserverToken,
} from '../engine/observerToken.js';
import {
  jsonCreated,
  jsonError,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';

export const channelRoutes = new Hono<AppEnv>();

const createChannelSchema = z.object({
  name: z.string().min(1),
  topic: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateChannelSchema = z.object({
  topic: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateChannelTopicSchema = z.object({
  topic: z.string(),
});

const inviteChannelSchema = z.object({
  agent_name: z.string().min(1),
});

function channelNotFound(c: Parameters<typeof jsonNotFound>[0], name: string) {
  return jsonNotFound(c, 'channel_not_found', `Channel "${name}" not found`);
}

function observerChannelAllowed(observer: ObserverToken | undefined, channel: { id?: string | null; name?: string | null }) {
  return observerAllowsChannel(observer, channel);
}

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
      const parsed = await parseJsonBody(c, createChannelSchema, 'name is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { name, topic, metadata } = parsed.data;

      const result = await channelEngine.createChannel(
        db,
        workspace.id,
        { name, topic: topic ?? undefined, metadata },
        agent?.id,
      );

      // Workspace-wide fanout so all online agents learn about the new channel.
      const eventData = { ...result, channel_name: result.name };
      runInBackground(c, fanoutToWorkspace(c, 'channel.created', eventData), 'fanout channel.created');
      // Update ChannelDO member cache (creator auto-joined)
      try {
        const members = await channelEngine.getMembers(db, workspace.id, result.name);
        runInBackground(c, updateChannelMembers(c, result.id, members.map((m) => m.agent_id)), 'update-members channel.created');
      } catch {
        // Ignore cache update failures
      }

      await sendWebhookEvent(c, {
        type: 'channel.created',
        workspaceId: workspace.id,
        data: { ...result, created_by_name: agent?.name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_created', {
        channel_id: result.id,
        channel_name: result.name,
      });

      return jsonCreated(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/channels - list channels
channelRoutes.get(
  '/channels',
  requireWorkspaceRead('channels:read'),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const includeArchived = c.req.query('include_archived') === 'true';
      const observer = getObserverTokenFromContext(c);
      const channels = await channelEngine.listChannels(
        db,
        workspace.id,
        includeArchived,
      );
      return jsonOk(c, channels.filter((channel) => observerChannelAllowed(observer, channel)));
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/channels/:name - get channel with members
channelRoutes.get(
  '/channels/:name',
  requireWorkspaceRead('channels:read'),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const channel = await channelEngine.getChannel(db, workspace.id, name);
      if (!channel) {
        return channelNotFound(c, name);
      }
      if (!observerChannelAllowed(getObserverTokenFromContext(c), channel)) {
        return channelNotFound(c, name);
      }
      return jsonOk(c, channel);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      const parsed = await parseJsonBody(c, updateChannelSchema, 'invalid channel update body');
      if (!parsed.ok) {
        return parsed.response;
      }
      const body = parsed.data;
      const updated = await channelEngine.updateChannel(
        db,
        workspace.id,
        name,
        body,
      );
      if (!updated) {
        return channelNotFound(c, name);
      }

      const eventData = { ...updated, channel_name: updated.name };
      runInBackground(c, fanoutToChannel(c, updated.id, 'channel.updated', eventData), 'fanout channel.updated');
      await sendWebhookEvent(c, {
        type: 'channel.updated',
        workspaceId: workspace.id,
        data: { ...updated, channel_name: name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_updated', {
        channel_id: updated.id,
        channel_name: updated.name,
      });

      return jsonOk(c, updated);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      const parsed = await parseJsonBody(c, updateChannelTopicSchema, 'topic is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { topic } = parsed.data;

      const updated = await channelEngine.updateChannel(
        db,
        workspace.id,
        name,
        { topic },
      );
      if (!updated) {
        return channelNotFound(c, name);
      }

      const eventData = { ...updated, channel_name: name };
      runInBackground(c, fanoutToChannel(c, updated.id, 'channel.updated', eventData), 'fanout channel.updated topic');
      await sendWebhookEvent(c, {
        type: 'channel.updated',
        workspaceId: workspace.id,
        data: { ...updated, channel_name: name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_topic_updated', {
        channel_id: updated.id,
        channel_name: updated.name,
      });

      return jsonOk(c, updated);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
        return channelNotFound(c, name);
      }

      const channel = await channelEngine.getChannel(db, workspace.id, name);
      if (channel) {
        const eventData = { channel_name: name };
        runInBackground(c, fanoutToChannel(c, channel.id, 'channel.archived', eventData), 'fanout channel.archived');
      }
      await sendWebhookEvent(c, {
        type: 'channel.archived',
        workspaceId: workspace.id,
        data: { channel_name: name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_archived', {
        channel_name: name,
      });

      return jsonNoContent(c);
    } catch (err: unknown) {
      return errorResponse(c, err);
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

      // Update member cache before fanout so new member receives event
      try {
        const members = await channelEngine.getMembers(db, workspace.id, name);
        const channel = await channelEngine.getChannel(db, workspace.id, name);
        if (channel) {
          runInBackground(c, updateChannelMembers(c, channel.id, members.map((m) => m.agent_id)), 'update-members member.joined');
          const eventData = { channel_name: name, agent_id: agent!.id, agent_name: agent!.name };
          runInBackground(c, fanoutToChannel(c, channel.id, 'member.joined', eventData), 'fanout member.joined');
        }
      } catch {
        // Ignore cache update failures
      }

      await sendWebhookEvent(c, {
        type: 'member.joined',
        workspaceId: workspace.id,
        data: { channel_name: name, agent_id: agent!.id, agent_name: agent!.name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_joined', {
        channel_name: name,
        agent_id: agent!.id,
      });

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
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

      // Fanout before removing member so leaver receives event
      try {
        const channel = await channelEngine.getChannel(db, workspace.id, name);
        if (channel) {
          const eventData = { channel_name: name, agent_id: agent!.id, agent_name: agent!.name };
          runInBackground(c, fanoutToChannel(c, channel.id, 'member.left', eventData), 'fanout member.left');
        }
      } catch {
        // Ignore fanout failures
      }

      // Update member + muted caches after leave
      try {
        const members = await channelEngine.getMembers(db, workspace.id, name);
        const channel = await channelEngine.getChannel(db, workspace.id, name);
        if (channel) {
          runInBackground(c, updateChannelMembers(c, channel.id, members.map((m) => m.agent_id)), 'update-members member.left');
          // Clear mute state so a rejoin starts unmuted
          const mutedIds = await channelEngine.getMutedMemberIds(db, workspace.id, name);
          runInBackground(c, updateChannelMuted(c, channel.id, mutedIds), 'update-muted member.left');
        }
      } catch {
        // Ignore cache update failures
      }

      await sendWebhookEvent(c, {
        type: 'member.left',
        workspaceId: workspace.id,
        data: { channel_name: name, agent_id: agent!.id, agent_name: agent!.name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_left', {
        channel_name: name,
        agent_id: agent!.id,
      });

      return jsonNoContent(c);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// GET /v1/channels/:name/members - list channel members
channelRoutes.get(
  '/channels/:name/members',
  requireWorkspaceRead('channels:read'),
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const name = c.req.param('name');
      const observer = getObserverTokenFromContext(c);
      if (observer) {
        const channel = await getChannelObserverResource(db, workspace.id, name);
        if (!channel || !observerChannelAllowed(observer, channel)) {
          return channelNotFound(c, name);
        }
      }
      const members = await channelEngine.getMembers(
        db,
        workspace.id,
        name,
      );
      return jsonOk(c, members);
    } catch (err: unknown) {
      return errorResponse(c, err);
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
      const parsed = await parseJsonBody(c, inviteChannelSchema, 'agent_name is required');
      if (!parsed.ok) {
        return parsed.response;
      }
      const { agent_name: agentName } = parsed.data;

      // For invite, we need to know who's doing the inviting
      const inviterAgentId = agent?.id;
      if (!inviterAgentId) {
        return jsonError(c, 'agent_token_required', 'Agent token required to invite others', 403);
      }

      const result = await channelEngine.inviteAgent(
        db,
        workspace.id,
        name,
        inviterAgentId,
        agentName,
      );

      // Update member cache and fanout
      try {
        const members = await channelEngine.getMembers(db, workspace.id, name);
        const channel = await channelEngine.getChannel(db, workspace.id, name);
        if (channel) {
          runInBackground(c, updateChannelMembers(c, channel.id, members.map((m) => m.agent_id)), 'update-members member.invited');
          const invitedMember = members.find((member) => member.agent_name === agentName);
          const eventData = { channel_name: name, agent_id: invitedMember?.agent_id, agent_name: agentName };
          runInBackground(c, fanoutToChannel(c, channel.id, 'member.joined', eventData), 'fanout member.invited');
        }
      } catch {
        // Ignore cache update failures
      }

      await sendWebhookEvent(c, {
        type: 'member.joined',
        workspaceId: workspace.id,
        data: { channel_name: name, agent_name: agentName, invited_by: agent?.name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_invited', {
        channel_name: name,
        invited_agent_name: agentName,
      });

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/channels/:name/mute - mute channel (agent token required)
channelRoutes.post(
  '/channels/:name/mute',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const name = c.req.param('name');
      const result = await channelEngine.muteChannel(
        db,
        workspace.id,
        name,
        agent!.id,
      );

      // Update ChannelDO muted set
      try {
        const mutedIds = await channelEngine.getMutedMemberIds(db, workspace.id, name);
        const channel = await channelEngine.getChannel(db, workspace.id, name);
        if (channel) {
          runInBackground(c, updateChannelMuted(c, channel.id, mutedIds), 'update-muted member.channel_muted');
          const eventData = { channel_name: name, agent_id: agent!.id, agent_name: agent!.name };
          runInBackground(c, fanoutToChannel(c, channel.id, 'member.channel_muted', eventData), 'fanout member.channel_muted');
        }
      } catch {
        // Ignore cache update failures
      }

      await sendWebhookEvent(c, {
        type: 'member.channel_muted',
        workspaceId: workspace.id,
        data: { channel_name: name, agent_id: agent!.id, agent_name: agent!.name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_muted', {
        channel_name: name,
        agent_id: agent!.id,
      });

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);

// POST /v1/channels/:name/unmute - unmute channel (agent token required)
channelRoutes.post(
  '/channels/:name/unmute',
  requireAgentToken,
  rateLimit,
  async (c) => {
    try {
      const db = c.get('db');
      const workspace = c.get('workspace');
      const agent = c.get('agent');
      const name = c.req.param('name');
      const result = await channelEngine.unmuteChannel(
        db,
        workspace.id,
        name,
        agent!.id,
      );

      // Update ChannelDO muted set
      try {
        const mutedIds = await channelEngine.getMutedMemberIds(db, workspace.id, name);
        const channel = await channelEngine.getChannel(db, workspace.id, name);
        if (channel) {
          runInBackground(c, updateChannelMuted(c, channel.id, mutedIds), 'update-muted member.channel_unmuted');
          const eventData = { channel_name: name, agent_id: agent!.id, agent_name: agent!.name };
          runInBackground(c, fanoutToChannel(c, channel.id, 'member.channel_unmuted', eventData), 'fanout member.channel_unmuted');
        }
      } catch {
        // Ignore cache update failures
      }

      await sendWebhookEvent(c, {
        type: 'member.channel_unmuted',
        workspaceId: workspace.id,
        data: { channel_name: name, agent_id: agent!.id, agent_name: agent!.name },
      });
      emitServerEvent(c, workspace.id, 'relaycast_server_channel_unmuted', {
        channel_name: name,
        agent_id: agent!.id,
      });

      return jsonOk(c, result);
    } catch (err: unknown) {
      return errorResponse(c, err);
    }
  },
);
