import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { transformForClient, type WsEvent } from '../engine/wsTransform.js';
import { isWorkspaceStreamEnabled } from '../lib/workspaceStream.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';
import { dmConversations, dmParticipants } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';

type HonoContext = Context<AppEnv>;

function buildEvent(
  type: string,
  workspaceId: string,
  data: Record<string, unknown>,
  channelId?: string,
): WsEvent {
  return {
    type,
    workspace_id: workspaceId,
    channel_id: channelId,
    data,
    timestamp: new Date().toISOString(),
  };
}

async function workspaceStreamEnabled(c: HonoContext, workspaceId: string): Promise<boolean> {
  const { kv, config } = c.get('engine');
  return isWorkspaceStreamEnabled(kv, workspaceId, config.workspaceStreamEnabled ?? false);
}

async function publishToWorkspaceStream(
  c: HonoContext,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.workspace_stream');
  if (!(await workspaceStreamEnabled(c, workspaceId))) return;
  try {
    await c.get('engine').realtime.publishToWorkspaceStream({ workspaceId, event: payload });
  } catch (err) {
    logger.error(`workspace stream publish error for workspace ${workspaceId}`, {
      workspace_id: workspaceId,
      ...toErrorDetails(err),
    });
  }
}

export async function fanoutToChannel(
  c: HonoContext,
  channelId: string,
  type: string,
  data: Record<string, unknown>,
  members?: string[], // Optional: provide members for member-cache initialization
  workspaceIdOverride?: string,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.channel');
  let workspaceId = workspaceIdOverride;
  if (!workspaceId) {
    const workspace = c.get('workspace');
    workspaceId = workspace?.id;
  }
  if (!workspaceId) {
    logger.error('fanoutToChannel missing workspace context', {
      channel_id: channelId,
      event_type: type,
    });
    return;
  }

  const event = buildEvent(type, workspaceId, data, channelId);
  const payload = transformForClient(event);
  const ws = workspaceId;

  const tasks: Promise<unknown>[] = [];
  tasks.push(
    c.get('engine').realtime
      .broadcastToChannel({ workspaceId: ws, channelId, event: payload, members })
      .catch((err) => {
        logger.error(`broadcastToChannel error for channel ${channelId}, event ${type}`, {
          workspace_id: ws,
          channel_id: channelId,
          event_type: type,
          ...toErrorDetails(err),
        });
      }),
  );
  tasks.push(publishToWorkspaceStream(c, ws, payload));

  await Promise.allSettled(tasks);
}

export async function fanoutToAgents(
  c: HonoContext,
  agentIds: string[],
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const workspaceId = c.get('workspace').id;
  const event = buildEvent(type, workspaceId, data);
  const payload = transformForClient(event);

  const unique = [...new Set(agentIds)];
  await Promise.allSettled([
    c.get('engine').realtime.deliverToAgents({ workspaceId, agentIds: unique, event: payload }),
    publishToWorkspaceStream(c, workspaceId, payload),
  ]);
}

export async function fanoutToWorkspace(
  c: HonoContext,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.workspace');
  const workspaceId = c.get('workspace').id;
  try {
    const agentIds = await c.get('engine').presence.getOnline(workspaceId);
    await fanoutToAgents(c, agentIds, type, data);
  } catch (err) {
    logger.error(`fanoutToWorkspace error for workspace ${workspaceId}, event ${type}`, {
      workspace_id: workspaceId,
      event_type: type,
      ...toErrorDetails(err),
    });
    throw err;
  }
}

/**
 * Check if a channel belongs to a DM conversation and return active participant
 * agent IDs. Returns `null` for regular (non-DM) channels or on any error so
 * callers can fall back to the standard `fanoutToChannel` path.
 */
export async function getDmParticipantAgentIds(
  c: HonoContext,
  channelId: string,
): Promise<string[] | null> {
  try {
    const db = c.get('db');
    const [conv] = await db
      .select({ id: dmConversations.id })
      .from(dmConversations)
      .where(eq(dmConversations.channelId, channelId));
    if (!conv) return null;
    const rows = await db
      .select({ agentId: dmParticipants.agentId })
      .from(dmParticipants)
      .where(and(eq(dmParticipants.conversationId, conv.id), isNull(dmParticipants.leftAt)));
    return rows.map((r) => r.agentId);
  } catch (err) {
    const logger = getRequestLogger(c, 'fanout.dm_lookup');
    logger.warn(`getDmParticipantAgentIds failed for channel ${channelId}`, {
      channel_id: channelId,
      ...toErrorDetails(err),
    });
    return null;
  }
}

export async function updateChannelMuted(
  c: HonoContext,
  channelId: string,
  mutedIds: string[],
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.update_channel_muted');
  const workspaceId = c.get('workspace').id;
  try {
    await c.get('engine').realtime.setChannelMuted(workspaceId, channelId, mutedIds);
  } catch (err) {
    logger.error(`setChannelMuted error for channel ${channelId}`, {
      workspace_id: workspaceId,
      channel_id: channelId,
      ...toErrorDetails(err),
    });
    throw err;
  }
}

export async function updateChannelMembers(
  c: HonoContext,
  channelId: string,
  memberIds: string[],
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.update_channel_members');
  const workspaceId = c.get('workspace').id;
  try {
    await c.get('engine').realtime.setChannelMembers(workspaceId, channelId, memberIds);
  } catch (err) {
    logger.error(`setChannelMembers error for channel ${channelId}`, {
      workspace_id: workspaceId,
      channel_id: channelId,
      ...toErrorDetails(err),
    });
    throw err;
  }
}
