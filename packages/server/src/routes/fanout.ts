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

async function deliverToAgent(
  c: HonoContext,
  agentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.deliver_to_agent');
  const workspaceId = c.get('workspace').id;
  try {
    const doId = c.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
    const stub = c.env.AGENT_DO.get(doId);
    const res = await stub.fetch(new Request('http://do/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, workspaceId, agentId }),
    }));
    if (!res.ok) {
      logger.error(`AgentDO deliver failed: ${res.status} for agent ${agentId}`, {
        workspace_id: workspaceId,
        agent_id: agentId,
        status: res.status,
      });
    }
  } catch (err) {
    logger.error(`AgentDO deliver error for agent ${agentId}`, {
      workspace_id: workspaceId,
      agent_id: agentId,
      ...toErrorDetails(err),
    });
    throw err;
  }
}

async function publishToWorkspaceStream(
  c: HonoContext,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const logger = getRequestLogger(c, 'fanout.workspace_stream');
  if (!(await isWorkspaceStreamEnabled(c.env, workspaceId))) return;
  try {
    const doId = c.env.WORKSPACE_STREAM_DO.idFromName(workspaceId);
    const stub = c.env.WORKSPACE_STREAM_DO.get(doId);
    const res = await stub.fetch(new Request('http://do/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
    if (!res.ok) {
      logger.error(`WorkspaceStreamDO deliver failed: ${res.status} for workspace ${workspaceId}`, {
        workspace_id: workspaceId,
        status: res.status,
      });
    }
  } catch (err) {
    logger.error(`WorkspaceStreamDO deliver error for workspace ${workspaceId}`, {
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
  members?: string[], // Optional: provide members for DO cache initialization
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

  const tasks: Promise<void>[] = [];
  tasks.push((async () => {
    try {
      const doId = c.env.CHANNEL_DO.idFromName(`${workspaceId}:${channelId}`);
      const stub = c.env.CHANNEL_DO.get(doId);
      const res = await stub.fetch(new Request('http://do/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, channelId, event: payload, members }),
      }));
      if (!res.ok) {
        logger.error(`ChannelDO broadcast failed: ${res.status} for channel ${channelId}, event ${type}`, {
          workspace_id: workspaceId,
          channel_id: channelId,
          event_type: type,
          status: res.status,
        });
      }
    } catch (err) {
      logger.error(`ChannelDO broadcast error for channel ${channelId}, event ${type}`, {
        workspace_id: workspaceId,
        channel_id: channelId,
        event_type: type,
        ...toErrorDetails(err),
      });
    }
  })());
  tasks.push(publishToWorkspaceStream(c, workspaceId, payload));

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
    ...unique.map((agentId) => deliverToAgent(c, agentId, payload)),
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
    const doId = c.env.PRESENCE_DO.idFromName(workspaceId);
    const stub = c.env.PRESENCE_DO.get(doId);
    const res = await stub.fetch(new Request('http://do/status'));
    if (!res.ok) {
      logger.error(`PresenceDO status failed: ${res.status} for workspace ${workspaceId}`, {
        workspace_id: workspaceId,
        event_type: type,
        status: res.status,
      });
      return;
    }
    const body = await res.json() as { agents?: string[] };
    const agentIds = body.agents ?? [];
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
  } catch {
    return null;
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
    const doId = c.env.CHANNEL_DO.idFromName(`${workspaceId}:${channelId}`);
    const stub = c.env.CHANNEL_DO.get(doId);
    const res = await stub.fetch(new Request('http://do/update-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: memberIds }),
    }));
    if (!res.ok) {
      logger.error(`ChannelDO update-members failed: ${res.status} for channel ${channelId}`, {
        workspace_id: workspaceId,
        channel_id: channelId,
        status: res.status,
      });
    }
  } catch (err) {
    logger.error(`ChannelDO update-members error for channel ${channelId}`, {
      workspace_id: workspaceId,
      channel_id: channelId,
      ...toErrorDetails(err),
    });
    throw err;
  }
}
