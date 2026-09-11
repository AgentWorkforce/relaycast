import { eq, and, sql, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { getDb } from '../db/index.js';
import { channels, channelMembers, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { getCachedChannel, setCachedChannel, invalidateChannelCache } from './cache.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

const SUBSCRIPTION_CHANNEL_PREFIX = 'agent-events-';
const subscriptionChannelMetadataSchema = z.object({
  subscription_agent_id: z.string().min(1),
});

function assertSubscriptionRecipient(channel: { name: string; metadata: unknown }, agentId: string) {
  if (!channel.name.startsWith(SUBSCRIPTION_CHANNEL_PREFIX)) return;
  const metadata = subscriptionChannelMetadataSchema.safeParse(channel.metadata);
  if (!metadata.success || metadata.data.subscription_agent_id !== agentId) {
    throw codedError('Only the subscription recipient may join this channel', 'subscription_recipient_only', 403);
  }
}

/** Owner-managed delivery route. Identity IDs prevent a recreated name inheriting old subscriptions. */
export async function ensureAgentSubscriptionChannel(db: Db, workspaceId: string, agentName: string) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));
  if (!agent || agent.status === 'released') throw codedError('Recipient agent not found', 'agent_not_found', 404);
  const name = `${SUBSCRIPTION_CHANNEL_PREFIX}${agent.id}`;
  await db.insert(channels).values({
    id: generateId(), workspaceId, name,
    metadata: { subscription_agent_id: agent.id },
  }).onConflictDoNothing();
  const [channel] = await db.select().from(channels).where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)));
  assertSubscriptionRecipient(channel, agent.id);
  if (channel.isArchived) throw codedError('Subscription channel is archived', 'channel_archived', 409);
  const [foreignMember] = await db.select({ agentId: channelMembers.agentId }).from(channelMembers)
    .where(and(eq(channelMembers.channelId, channel.id), ne(channelMembers.agentId, agent.id))).limit(1);
  if (foreignMember) throw codedError('Existing subscription channel has another recipient', 'subscription_channel_conflict', 409);

  // Recheck the identity in the INSERT, serialized with tombstoning/removal.
  // A release between the lookup and this write must never rejoin a tombstone.
  await db.run(sql`INSERT INTO channel_members (channel_id, agent_id, role)
    SELECT ${channel.id}, id, 'owner' FROM agents
    WHERE id = ${agent.id} AND name = ${agentName} AND status != 'released'
    ON CONFLICT DO NOTHING`);
  const [recipient] = await db.select({ agentId: agents.id }).from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(and(eq(channelMembers.channelId, channel.id), eq(agents.id, agent.id), eq(agents.name, agentName), ne(agents.status, 'released'))).limit(1);
  if (!recipient) throw codedError('Recipient agent was released during subscription setup', 'agent_not_found', 404);
  await invalidateChannelCache(workspaceId, name);
  return getChannel(db, workspaceId, name);
}

export async function createChannel(
  db: Db,
  workspaceId: string,
  data: { name: string; topic?: string; metadata?: Record<string, unknown> },
  creatorAgentId?: string,
) {
  if (data.name.startsWith(SUBSCRIPTION_CHANNEL_PREFIX)) {
    throw codedError('Channel prefix is reserved for agent subscriptions', 'reserved_channel_name', 400);
  }
  // Validate channel name: lowercase alphanumeric + hyphens
  if (!/^[a-z0-9][a-z0-9-]*$/.test(data.name)) {
    throw codedError('Channel name must be lowercase alphanumeric and hyphens, starting with a letter or number', 'invalid_channel_name', 400);
  }

  // Check for duplicate name within workspace
  const [existing] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, data.name)),
    );
  if (existing) {
    throw codedError(`Channel "${data.name}" already exists`, 'channel_already_exists', 409);
  }

  const channelId = generateId();
  const [channel] = await db
    .insert(channels)
    .values({
      id: channelId,
      workspaceId,
      name: data.name,
      topic: data.topic ?? null,
      metadata: data.metadata ?? {},
      createdBy: creatorAgentId ?? null,
    })
    .returning();

  // Creator auto-joins as owner
  if (creatorAgentId) {
    await db.insert(channelMembers).values({
      channelId,
      agentId: creatorAgentId,
      role: 'owner',
    });
  }

  return {
    id: channel.id,
    name: channel.name,
    topic: channel.topic,
    metadata: channel.metadata ?? {},
    created_by: channel.createdBy,
    created_at: channel.createdAt.toISOString(),
    member_count: creatorAgentId ? 1 : 0,
  };
}

export async function listChannels(
  db: Db,
  workspaceId: string,
  includeArchived = false,
) {
  let rows;
  if (includeArchived) {
    rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.channelType, 0),
        ),
      );
  } else {
    rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.channelType, 0),
          eq(channels.isArchived, false),
        ),
      );
  }

  if (rows.length === 0) return [];

  const channelIds = rows.map((ch) => ch.id);

  // Batch: member counts
  const memberCounts = await db
    .select({ channelId: channelMembers.channelId, count: sql<number>`count(*)` })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, channelIds))
    .groupBy(channelMembers.channelId);

  const memberCountMap = new Map(memberCounts.map((r) => [r.channelId, r.count]));

  return rows.map((ch) => ({
    id: ch.id,
    name: ch.name,
    topic: ch.topic,
    metadata: ch.metadata ?? {},
    member_count: memberCountMap.get(ch.id) ?? 0,
    created_at: ch.createdAt.toISOString(),
    is_archived: ch.isArchived,
  }));
}

export async function getChannel(db: Db, workspaceId: string, name: string) {
  // Subscription membership is a launch/lifecycle proof. Read it live even when
  // a node lifecycle release bypasses the normal channel mutation handlers.
  const cacheable = !name.startsWith(SUBSCRIPTION_CHANNEL_PREFIX);
  const cached = cacheable ? await getCachedChannel(workspaceId, name) : null;
  if (cached) return cached;

  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)),
    );

  if (!channel) return null;

  // Get members
  const members = await db
    .select({
      agent_id: channelMembers.agentId,
      agent_name: agents.name,
      role: channelMembers.role,
      joined_at: channelMembers.joinedAt,
      is_muted: channelMembers.isMuted,
    })
    .from(channelMembers)
    .innerJoin(agents, eq(channelMembers.agentId, agents.id))
    .where(eq(channelMembers.channelId, channel.id));

  const result = {
    id: channel.id,
    name: channel.name,
    topic: channel.topic,
    metadata: channel.metadata ?? {},
    member_count: members.length,
    members: members.map((m) => ({
      agent_id: m.agent_id,
      agent_name: m.agent_name,
      role: m.role,
      joined_at: m.joined_at.toISOString(),
      is_muted: m.is_muted,
    })),
    created_at: channel.createdAt.toISOString(),
    is_archived: channel.isArchived,
  };

  // Populate cache
  if (cacheable) await setCachedChannel(workspaceId, name, result);

  return result;
}

export async function updateChannel(
  db: Db,
  workspaceId: string,
  name: string,
  updates: { topic?: string | null; metadata?: Record<string, unknown> },
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)),
    );

  if (!channel) return null;

  if (channel.isArchived) {
    throw codedError('Cannot update an archived channel', 'channel_archived', 400);
  }

  if (name.startsWith(SUBSCRIPTION_CHANNEL_PREFIX) && updates.metadata !== undefined) {
    throw codedError('Subscription routing metadata is immutable', 'subscription_metadata_immutable', 403);
  }
  const setClause: Record<string, unknown> = {};
  if (updates.topic !== undefined) setClause.topic = updates.topic;
  if (updates.metadata !== undefined) setClause.metadata = updates.metadata;

  if (Object.keys(setClause).length === 0) {
    return getChannel(db, workspaceId, name);
  }

  const [updated] = await db
    .update(channels)
    .set(setClause)
    .where(eq(channels.id, channel.id))
    .returning();

  // Invalidate cache on update
  await invalidateChannelCache(workspaceId, name);

  return {
    id: updated.id,
    name: updated.name,
    topic: updated.topic,
    metadata: updated.metadata ?? {},
    created_at: updated.createdAt.toISOString(),
    is_archived: updated.isArchived,
  };
}

export async function archiveChannel(db: Db, workspaceId: string, name: string) {
  // #general cannot be deleted
  if (name === 'general') {
    throw codedError('The #general channel cannot be archived', 'cannot_archive_general', 400);
  }

  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)),
    );

  if (!channel) return false;

  await db
    .update(channels)
    .set({ isArchived: true })
    .where(eq(channels.id, channel.id));

  await invalidateChannelCache(workspaceId, name);

  return true;
}

export async function joinChannel(
  db: Db,
  workspaceId: string,
  channelName: string,
  agentId: string,
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) {
    throw codedError(`Channel "${channelName}" not found`, 'channel_not_found', 404);
  }

  if (channel.isArchived) {
    throw codedError('Cannot join an archived channel', 'channel_archived', 400);
  }

  assertSubscriptionRecipient(channel, agentId);

  // Check if already a member
  const [existing] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );

  if (existing) {
    return { channel: channelName, agent_id: agentId, already_member: true };
  }

  if (channel.name.startsWith(SUBSCRIPTION_CHANNEL_PREFIX)) {
    // Serialize the liveness check with release's membership removal.
    await db.run(sql`INSERT INTO channel_members (channel_id, agent_id, role)
      SELECT ${channel.id}, id, 'member' FROM agents
      WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND status != 'released'
      ON CONFLICT DO NOTHING`);
    const [recipient] = await db.select({ id: agents.id }).from(channelMembers)
      .innerJoin(agents, eq(agents.id, channelMembers.agentId))
      .where(and(eq(channelMembers.channelId, channel.id), eq(agents.id, agentId), ne(agents.status, 'released'))).limit(1);
    if (!recipient) throw codedError('Subscription recipient was released', 'agent_not_found', 404);
  } else {
    await db.insert(channelMembers).values({ channelId: channel.id, agentId, role: 'member' });
  }

  await invalidateChannelCache(workspaceId, channelName);

  return { channel: channelName, agent_id: agentId, already_member: false };
}

export async function leaveChannel(
  db: Db,
  workspaceId: string,
  channelName: string,
  agentId: string,
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) {
    throw codedError(`Channel "${channelName}" not found`, 'channel_not_found', 404);
  }

  await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );

  await invalidateChannelCache(workspaceId, channelName);
}

export async function getMembers(db: Db, workspaceId: string, channelName: string) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) {
    throw codedError(`Channel "${channelName}" not found`, 'channel_not_found', 404);
  }

  const members = await db
    .select({
      agent_id: channelMembers.agentId,
      agent_name: agents.name,
      role: channelMembers.role,
      joined_at: channelMembers.joinedAt,
      is_muted: channelMembers.isMuted,
    })
    .from(channelMembers)
    .innerJoin(agents, eq(channelMembers.agentId, agents.id))
    .where(eq(channelMembers.channelId, channel.id));

  return members.map((m) => ({
    agent_id: m.agent_id,
    agent_name: m.agent_name,
    role: m.role,
    joined_at: m.joined_at.toISOString(),
    is_muted: m.is_muted,
  }));
}

export async function inviteAgent(
  db: Db,
  workspaceId: string,
  channelName: string,
  inviterAgentId: string,
  inviteeAgentName: string,
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) {
    throw codedError(`Channel "${channelName}" not found`, 'channel_not_found', 404);
  }

  if (channel.isArchived) {
    throw codedError('Cannot invite to an archived channel', 'channel_archived', 400);
  }

  // Check inviter is a member
  const [inviterMembership] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, inviterAgentId),
      ),
    );

  if (!inviterMembership) {
    throw codedError('You must be a member of the channel to invite others', 'not_a_member', 403);
  }

  // Find invitee agent
  const [invitee] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.name, inviteeAgentName),
      ),
    );

  if (!invitee) {
    throw codedError(`Agent "${inviteeAgentName}" not found`, 'agent_not_found', 404);
  }

  assertSubscriptionRecipient(channel, invitee.id);

  // Check if already a member
  const [existing] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, invitee.id),
      ),
    );

  if (!existing) {
    await db.insert(channelMembers).values({
      channelId: channel.id,
      agentId: invitee.id,
      role: 'member',
    });
    await invalidateChannelCache(workspaceId, channelName);
  }

  return { channel: channelName, agent: inviteeAgentName };
}

export async function muteChannel(
  db: Db,
  workspaceId: string,
  channelName: string,
  agentId: string,
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) {
    throw codedError(`Channel "${channelName}" not found`, 'channel_not_found', 404);
  }

  const [membership] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );

  if (!membership) {
    throw codedError('You must be a member of the channel to mute it', 'not_a_member', 403);
  }

  await db
    .update(channelMembers)
    .set({ isMuted: true })
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );

  await invalidateChannelCache(workspaceId, channelName);

  return { channel: channelName, agent_id: agentId, muted: true };
}

export async function unmuteChannel(
  db: Db,
  workspaceId: string,
  channelName: string,
  agentId: string,
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) {
    throw codedError(`Channel "${channelName}" not found`, 'channel_not_found', 404);
  }

  const [membership] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );

  if (!membership) {
    throw codedError('You must be a member of the channel to unmute it', 'not_a_member', 403);
  }

  await db
    .update(channelMembers)
    .set({ isMuted: false })
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );

  await invalidateChannelCache(workspaceId, channelName);

  return { channel: channelName, agent_id: agentId, muted: false };
}

export async function getMutedMemberIds(
  db: Db,
  workspaceId: string,
  channelName: string,
): Promise<string[]> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.name, channelName),
      ),
    );

  if (!channel) return [];

  const rows = await db
    .select({ agent_id: channelMembers.agentId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.isMuted, true),
      ),
    );

  return rows.map((r) => r.agent_id);
}
