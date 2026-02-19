import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { transformForClient, type WsEvent } from '../engine/wsTransform.js';
import { isWorkspaceStreamEnabled } from '../lib/workspaceStream.js';

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
      console.error(`[fanout] AgentDO deliver failed: ${res.status} for agent ${agentId}`);
    }
  } catch (err) {
    console.error(`[fanout] AgentDO deliver error for agent ${agentId}:`, err);
    throw err;
  }
}

async function publishToWorkspaceStream(
  c: HonoContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const workspaceId = c.get('workspace').id;
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
      console.error(`[fanout] WorkspaceStreamDO deliver failed: ${res.status} for workspace ${workspaceId}`);
    }
  } catch (err) {
    console.error(`[fanout] WorkspaceStreamDO deliver error for workspace ${workspaceId}:`, err);
  }
}

export async function fanoutToChannel(
  c: HonoContext,
  channelId: string,
  type: string,
  data: Record<string, unknown>,
  members?: string[], // Optional: provide members for DO cache initialization
): Promise<void> {
  const workspaceId = c.get('workspace').id;
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
        console.error(`[fanout] ChannelDO broadcast failed: ${res.status} for channel ${channelId}, event ${type}`);
      }
    } catch (err) {
      console.error(`[fanout] ChannelDO broadcast error for channel ${channelId}, event ${type}:`, err);
    }
  })());
  tasks.push(publishToWorkspaceStream(c, payload));

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
    publishToWorkspaceStream(c, payload),
  ]);
}

export async function fanoutToWorkspace(
  c: HonoContext,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const workspaceId = c.get('workspace').id;
  try {
    const doId = c.env.PRESENCE_DO.idFromName(workspaceId);
    const stub = c.env.PRESENCE_DO.get(doId);
    const res = await stub.fetch(new Request('http://do/status'));
    if (!res.ok) {
      console.error(`[fanout] PresenceDO status failed: ${res.status} for workspace ${workspaceId}`);
      return;
    }
    const body = await res.json() as { agents?: string[] };
    const agentIds = body.agents ?? [];
    await fanoutToAgents(c, agentIds, type, data);
  } catch (err) {
    console.error(`[fanout] fanoutToWorkspace error for workspace ${workspaceId}, event ${type}:`, err);
    throw err;
  }
}

export async function updateChannelMembers(
  c: HonoContext,
  channelId: string,
  memberIds: string[],
): Promise<void> {
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
      console.error(`[fanout] ChannelDO update-members failed: ${res.status} for channel ${channelId}`);
    }
  } catch (err) {
    console.error(`[fanout] ChannelDO update-members error for channel ${channelId}:`, err);
    throw err;
  }
}
