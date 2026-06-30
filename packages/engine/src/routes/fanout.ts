import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { transformForClient, type WsEvent } from '../engine/wsTransform.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';
import { dmConversations, dmParticipants } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { sendNodeContextForChannel, sendNodeContextToAgents } from '../engine/nodeContext.js';

type HonoContext = Context<AppEnv>;

const NODE_DELIVERY_EVENT_TYPES = new Set([
  'message.created',
  'thread.reply',
  'message.read',
  'message.reacted',
]);

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

async function publishToWorkspaceStream(
  c: HonoContext,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.workspace_stream');
  try {
    await c.get('engine').realtime.publishToWorkspaceStream({ workspaceId, event: payload });
  } catch (err) {
    logger.error(`workspace stream publish error for workspace ${workspaceId}`, {
      workspace_id: workspaceId,
      ...toErrorDetails(err),
    });
  }
}

export async function publishWorkspaceEvent(
  c: HonoContext,
  type: string,
  data: Record<string, unknown>,
  channelId?: string,
): Promise<void> {
  const workspaceId = c.get('workspace').id;
  if (channelId) {
    await fanoutToChannel(c, channelId, type, data, workspaceId);
    return;
  }
  const event = buildEvent(type, workspaceId, data, channelId);
  await publishToWorkspaceStream(c, workspaceId, transformForClient(event));
}

export async function fanoutToChannel(
  c: HonoContext,
  channelId: string,
  type: string,
  data: Record<string, unknown>,
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
  tasks.push(publishToWorkspaceStream(c, ws, payload));
  if (!NODE_DELIVERY_EVENT_TYPES.has(type)) {
    tasks.push(
      sendNodeContextForChannel(
        {
          db: c.get('db'),
          nodeConnections: c.get('engine').nodeConnections,
          environment: c.get('engine').config?.environment,
          realtime: c.get('engine').realtime,
          workspaceId: ws,
        },
        {
          channelId,
          topic: type.startsWith('thread.') ? 'thread' : 'channel',
          event: type,
          data,
        },
      ).catch((err) => {
        logger.error(`node context error for channel ${channelId}, event ${type}`, {
          workspace_id: ws,
          channel_id: channelId,
          event_type: type,
          ...toErrorDetails(err),
        });
      }),
    );
  }

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
  const tasks: Promise<unknown>[] = [
    publishToWorkspaceStream(c, workspaceId, payload),
  ];
  if (!NODE_DELIVERY_EVENT_TYPES.has(type)) {
    tasks.push(sendNodeContextToAgents(
      {
        db: c.get('db'),
        nodeConnections: c.get('engine').nodeConnections,
        environment: c.get('engine').config?.environment,
        realtime: c.get('engine').realtime,
        workspaceId,
      },
      {
        agentIds: unique,
        event: type,
        data,
      },
    ));
  }
  await Promise.allSettled(tasks);
}

export async function fanoutToWorkspace(
  c: HonoContext,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.workspace');
  const workspaceId = c.get('workspace').id;
  try {
    await publishWorkspaceEvent(c, type, data);
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
