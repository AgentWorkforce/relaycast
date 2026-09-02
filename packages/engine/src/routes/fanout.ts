import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { getRequestLogger, toErrorDetails } from '../lib/logger.js';
import { dmConversations, dmParticipants } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import {
  publishEvent,
  type EventDispatchScope,
  type EventSinkErrorHandler,
} from '../engine/eventDispatch.js';

type HonoContext = Context<AppEnv>;

/**
 * Route-level wrappers over the single event dispatcher
 * (`engine/eventDispatch.ts`). They only name the audience — which sinks an
 * event reaches, and whether it is durable or ephemeral for nodes, is decided
 * there.
 */

function sinkErrorLogger(
  c: HonoContext,
  workspaceId: string,
  type: string,
  channelId?: string,
): EventSinkErrorHandler {
  return (sink, err) => {
    const logger = getRequestLogger(c, `fanout.${sink}`);
    logger.error(`${sink} error for workspace ${workspaceId}, event ${type}`, {
      workspace_id: workspaceId,
      ...(channelId ? { channel_id: channelId } : {}),
      event_type: type,
      ...toErrorDetails(err),
    });
  };
}

async function dispatch(
  c: HonoContext,
  workspaceId: string,
  type: string,
  data: Record<string, unknown>,
  scope: EventDispatchScope,
): Promise<void> {
  await publishEvent(
    { db: c.get('db'), engine: c.get('engine') },
    {
      workspaceId,
      type,
      data,
      scope,
      onSinkError: sinkErrorLogger(
        c,
        workspaceId,
        type,
        scope.kind === 'channel' ? scope.channelId : undefined,
      ),
    },
  );
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
  await dispatch(c, workspaceId, type, data, { kind: 'workspace' });
}

export async function fanoutToChannel(
  c: HonoContext,
  channelId: string,
  type: string,
  data: Record<string, unknown>,
  workspaceIdOverride?: string,
): Promise<void> {
  let workspaceId = workspaceIdOverride;
  if (!workspaceId) {
    const workspace = c.get('workspace');
    workspaceId = workspace?.id;
  }
  if (!workspaceId) {
    const logger = getRequestLogger(c, 'fanout.channel');
    logger.error('fanoutToChannel missing workspace context', {
      channel_id: channelId,
      event_type: type,
    });
    return;
  }

  await dispatch(c, workspaceId, type, data, { kind: 'channel', channelId });
}

export async function fanoutToAgents(
  c: HonoContext,
  agentIds: string[],
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await dispatch(c, c.get('workspace').id, type, data, { kind: 'agents', agentIds });
}

export async function fanoutToWorkspace(
  c: HonoContext,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await publishWorkspaceEvent(c, type, data);
}

/**
 * Fan an event out to the workspace stream and to the nodes hosting agents that
 * observe presence for `subjectAgentId`.
 */
export async function fanoutPresence(
  c: HonoContext,
  subjectAgentId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await dispatch(c, c.get('workspace').id, type, data, { kind: 'presence', subjectAgentId });
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
