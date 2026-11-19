import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { channels, dmConversations, dmParticipants, messages } from '../db/tables.js';
import { queryInChunks } from '../lib/queryChunks.js';

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
 * carries a conversation id or a non-zero channel type.
 *
 * Rows are attributed by their backing channel, because a message posted to a
 * DM through the channel route is logged without a conversation id; the
 * conversation id is the fallback for a row with no channel id. A DM row with
 * neither cannot be attributed and is dropped.
 */
export async function filterAgentVisibleDmResults<T extends {
  channel_id?: string | null;
  conversation_id?: string | null;
  channel_type?: number | null;
}>(
  db: Db,
  agentId: string | undefined,
  results: T[],
): Promise<T[]> {
  if (!agentId || results.length === 0) return results;
  const isDm = (result: T) => Boolean(result.conversation_id) || isDmBackedChannelType(result.channel_type);
  const dmRows = results.filter(isDm);
  if (dmRows.length === 0) return results;

  const distinct = (values: Array<string | null | undefined>) =>
    [...new Set(values.filter((value): value is string => Boolean(value)))];
  const channelIds = distinct(dmRows.map((row) => row.channel_id));
  const conversationIds = distinct(dmRows.filter((row) => !row.channel_id).map((row) => row.conversation_id));

  // A page can hold up to 100 distinct conversations; chunk to stay inside
  // D1's bound-parameter ceiling.
  const byChannel = await queryInChunks(channelIds, (ids) => db
    .select({ channelId: dmConversations.channelId })
    .from(dmConversations)
    .innerJoin(dmParticipants, eq(dmParticipants.conversationId, dmConversations.id))
    .where(and(
      eq(dmParticipants.agentId, agentId),
      isNull(dmParticipants.leftAt),
      inArray(dmConversations.channelId, ids),
    )));
  const byConversation = await queryInChunks(conversationIds, (ids) => db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(and(
      eq(dmParticipants.agentId, agentId),
      isNull(dmParticipants.leftAt),
      inArray(dmParticipants.conversationId, ids),
    )));
  const allowedChannels = new Set(byChannel.map((row) => row.channelId));
  const allowedConversations = new Set(byConversation.map((row) => row.conversationId));

  return results.filter((result) => {
    if (!isDm(result)) return true;
    if (result.channel_id) return allowedChannels.has(result.channel_id);
    return Boolean(result.conversation_id && allowedConversations.has(result.conversation_id));
  });
}
