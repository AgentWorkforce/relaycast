import { eq, and, sql, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { channels, channelMembers, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { getCachedChannel, setCachedChannel, invalidateChannelCache } from './cache.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

export async function createChannel(
  db: Db,
  workspaceId: string,
  data: { name: string; topic?: string; metadata?: Record<string, unknown> },
  creatorAgentId?: string,
) {
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
  // Check in-memory cache first
  const cached = await getCachedChannel(workspaceId, name);
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
  await setCachedChannel(workspaceId, name, result);

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

  await db.insert(channelMembers).values({
    channelId: channel.id,
    agentId,
    role: 'member',
  });

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
