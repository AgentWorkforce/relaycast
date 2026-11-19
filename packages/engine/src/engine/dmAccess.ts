import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { channels, dmConversations, dmParticipants, messages } from '../db/tables.js';

type Db = ReturnType<typeof getDb>;

/**
 * DM and group-DM conversations are stored on ordinary `channels` rows
 * (`channel_type` 1 and 2). Routes that address a channel by name or a message
 * by id therefore reach DM content too, and must apply the same rule the `/dm`
 * routes do: an agent sees a conversation only while it is a participant.
 *
 * These helpers answer that question for an *agent* principal. Workspace keys
 * keep full access, and observer tokens are scoped by their own filters.
 */

/** channel_type 0 is a regular channel; anything else backs a DM conversation. */
export function isDmBackedChannelType(channelType: number | null | undefined): boolean {
  return channelType != null && channelType !== 0;
}

async function isActiveParticipantOfChannel(db: Db, channelId: string, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentId: dmParticipants.agentId })
    .from(dmConversations)
    .innerJoin(dmParticipants, eq(dmParticipants.conversationId, dmConversations.id))
    .where(and(
      eq(dmConversations.channelId, channelId),
      eq(dmParticipants.agentId, agentId),
      isNull(dmParticipants.leftAt),
    ));
  return Boolean(row);
}

export type DmChannelAccess =
  /** No such channel, or a regular channel: the DM rule does not apply. */
  | 'not_dm'
  | 'participant'
  | 'outsider';

/** Classifies a channel name against the DM participant rule for one agent. */
export async function agentDmAccessForChannelName(
  db: Db,
  workspaceId: string,
  agentId: string,
  channelName: string,
): Promise<DmChannelAccess> {
  const [channel] = await db
    .select({ id: channels.id, channelType: channels.channelType })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, channelName)));
  if (!channel || !isDmBackedChannelType(channel.channelType)) return 'not_dm';
  return (await isActiveParticipantOfChannel(db, channel.id, agentId)) ? 'participant' : 'outsider';
}

/** Classifies a message id against the DM participant rule for one agent. */
export async function agentDmAccessForMessage(
  db: Db,
  workspaceId: string,
  agentId: string,
  messageId: string,
): Promise<DmChannelAccess> {
  const [row] = await db
    .select({ channelId: channels.id, channelType: channels.channelType })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  if (!row || !isDmBackedChannelType(row.channelType)) return 'not_dm';
  return (await isActiveParticipantOfChannel(db, row.channelId, agentId)) ? 'participant' : 'outsider';
}

/**
 * Drops DM rows the agent is not a participant in from a mixed result list
 * (search hits, console message logs). A row is treated as DM content when it
 * carries a conversation id or a non-zero channel type; a DM row without a
 * conversation id cannot be attributed and is dropped.
 */
export async function filterAgentVisibleDmResults<T extends {
  conversation_id?: string | null;
  channel_type?: number | null;
}>(
  db: Db,
  agentId: string | undefined,
  results: T[],
): Promise<T[]> {
  if (!agentId || results.length === 0) return results;
  const isDm = (result: T) => Boolean(result.conversation_id) || isDmBackedChannelType(result.channel_type);
  const conversationIds = [...new Set(results
    .filter(isDm)
    .map((result) => result.conversation_id)
    .filter((id): id is string => Boolean(id)))];
  if (conversationIds.length === 0) return results.filter((result) => !isDm(result));

  const rows = await db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(and(
      eq(dmParticipants.agentId, agentId),
      isNull(dmParticipants.leftAt),
      inArray(dmParticipants.conversationId, conversationIds),
    ));
  const allowed = new Set(rows.map((row) => row.conversationId));
  return results.filter((result) => !isDm(result) || Boolean(result.conversation_id && allowed.has(result.conversation_id)));
}
