import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { channels, channelMembers, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';

export async function createChannel(
  workspaceId: string,
  data: { name: string; topic?: string },
  creatorAgentId?: string,
) {
  const db = getDb();

  // Validate channel name: lowercase alphanumeric + hyphens
  if (!/^[a-z0-9][a-z0-9-]*$/.test(data.name)) {
    const err = new Error(
      'Channel name must be lowercase alphanumeric and hyphens, starting with a letter or number',
    );
    Object.assign(err, { code: 'invalid_channel_name', status: 400 });
    throw err;
  }

  // Check for duplicate name within workspace
  const [existing] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, data.name)),
    );
  if (existing) {
    const err = new Error(`Channel "${data.name}" already exists`);
    Object.assign(err, { code: 'channel_already_exists', status: 409 });
    throw err;
  }

  const channelId = generateId();
  const [channel] = await db
    .insert(channels)
    .values({
      id: channelId,
      workspaceId,
      name: data.name,
      topic: data.topic ?? null,
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
    created_by: channel.createdBy,
    created_at: channel.createdAt.toISOString(),
    member_count: creatorAgentId ? 1 : 0,
  };
}

export async function listChannels(
  workspaceId: string,
  includeArchived = false,
) {
  const db = getDb();

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

  // Get member counts
  const result = [];
  for (const ch of rows) {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, ch.id));

    result.push({
      id: ch.id,
      name: ch.name,
      topic: ch.topic,
      member_count: countRow?.count ?? 0,
      created_at: ch.createdAt.toISOString(),
      is_archived: ch.isArchived,
    });
  }

  return result;
}

export async function getChannel(workspaceId: string, name: string) {
  const db = getDb();
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
    })
    .from(channelMembers)
    .innerJoin(agents, eq(channelMembers.agentId, agents.id))
    .where(eq(channelMembers.channelId, channel.id));

  return {
    id: channel.id,
    name: channel.name,
    topic: channel.topic,
    member_count: members.length,
    members: members.map((m) => ({
      agent_id: m.agent_id,
      agent_name: m.agent_name,
      role: m.role,
      joined_at: m.joined_at.toISOString(),
    })),
    created_at: channel.createdAt.toISOString(),
    is_archived: channel.isArchived,
  };
}

export async function updateChannel(
  workspaceId: string,
  name: string,
  updates: { topic?: string },
) {
  const db = getDb();
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)),
    );

  if (!channel) return null;

  if (channel.isArchived) {
    const err = new Error('Cannot update an archived channel');
    Object.assign(err, { code: 'channel_archived', status: 400 });
    throw err;
  }

  const setClause: Record<string, unknown> = {};
  if (updates.topic !== undefined) setClause.topic = updates.topic;

  if (Object.keys(setClause).length === 0) {
    return getChannel(workspaceId, name);
  }

  const [updated] = await db
    .update(channels)
    .set(setClause)
    .where(eq(channels.id, channel.id))
    .returning();

  return {
    id: updated.id,
    name: updated.name,
    topic: updated.topic,
    created_at: updated.createdAt.toISOString(),
    is_archived: updated.isArchived,
  };
}

export async function archiveChannel(workspaceId: string, name: string) {
  const db = getDb();

  // #general cannot be deleted
  if (name === 'general') {
    const err = new Error('The #general channel cannot be archived');
    Object.assign(err, { code: 'cannot_archive_general', status: 400 });
    throw err;
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

  return true;
}

export async function joinChannel(
  workspaceId: string,
  channelName: string,
  agentId: string,
) {
  const db = getDb();
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
    const err = new Error(`Channel "${channelName}" not found`);
    Object.assign(err, { code: 'channel_not_found', status: 404 });
    throw err;
  }

  if (channel.isArchived) {
    const err = new Error('Cannot join an archived channel');
    Object.assign(err, { code: 'channel_archived', status: 400 });
    throw err;
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

  return { channel: channelName, agent_id: agentId, already_member: false };
}

export async function leaveChannel(
  workspaceId: string,
  channelName: string,
  agentId: string,
) {
  const db = getDb();
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
    const err = new Error(`Channel "${channelName}" not found`);
    Object.assign(err, { code: 'channel_not_found', status: 404 });
    throw err;
  }

  await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channel.id),
        eq(channelMembers.agentId, agentId),
      ),
    );
}

export async function getMembers(workspaceId: string, channelName: string) {
  const db = getDb();
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
    const err = new Error(`Channel "${channelName}" not found`);
    Object.assign(err, { code: 'channel_not_found', status: 404 });
    throw err;
  }

  const members = await db
    .select({
      agent_id: channelMembers.agentId,
      agent_name: agents.name,
      role: channelMembers.role,
      joined_at: channelMembers.joinedAt,
    })
    .from(channelMembers)
    .innerJoin(agents, eq(channelMembers.agentId, agents.id))
    .where(eq(channelMembers.channelId, channel.id));

  return members.map((m) => ({
    agent_id: m.agent_id,
    agent_name: m.agent_name,
    role: m.role,
    joined_at: m.joined_at.toISOString(),
  }));
}

export async function inviteAgent(
  workspaceId: string,
  channelName: string,
  inviterAgentId: string,
  inviteeAgentName: string,
) {
  const db = getDb();
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
    const err = new Error(`Channel "${channelName}" not found`);
    Object.assign(err, { code: 'channel_not_found', status: 404 });
    throw err;
  }

  if (channel.isArchived) {
    const err = new Error('Cannot invite to an archived channel');
    Object.assign(err, { code: 'channel_archived', status: 400 });
    throw err;
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
    const err = new Error('You must be a member of the channel to invite others');
    Object.assign(err, { code: 'not_a_member', status: 403 });
    throw err;
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
    const err = new Error(`Agent "${inviteeAgentName}" not found`);
    Object.assign(err, { code: 'agent_not_found', status: 404 });
    throw err;
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
  }

  return { channel: channelName, agent: inviteeAgentName };
}
