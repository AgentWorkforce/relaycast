import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agents, channels, channelMembers } from '../db/schema.js';
import { generateId } from './snowflake.js';

export async function registerAgent(
  workspaceId: string,
  data: {
    name: string;
    type?: string;
    persona?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const db = getDb();

  // Check for duplicate name within workspace
  const [existing] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.name)));
  if (existing) {
    const err = new Error(`Agent "${data.name}" already exists in this workspace`);
    Object.assign(err, { code: 'agent_already_exists', status: 409 });
    throw err;
  }

  const agentId = generateId();
  const token = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const [agent] = await db
    .insert(agents)
    .values({
      id: agentId,
      workspaceId,
      name: data.name,
      type: data.type || 'agent',
      tokenHash,
      persona: data.persona ?? null,
      metadata: data.metadata ?? {},
    })
    .returning();

  // Auto-join #general
  const [generalChannel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.name, 'general')),
    );

  if (generalChannel) {
    await db.insert(channelMembers).values({
      channelId: generalChannel.id,
      agentId,
      role: 'member',
    });
  }

  return {
    id: agentId,
    name: agent.name,
    token,
    status: agent.status,
    created_at: agent.createdAt.toISOString(),
  };
}

export async function listAgents(workspaceId: string, status?: string) {
  const db = getDb();

  let rows;
  if (status && status !== 'all') {
    rows = await db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId), eq(agents.status, status)),
      );
  } else {
    rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId));
  }

  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status,
    persona: a.persona,
    last_seen: a.lastSeen.toISOString(),
    metadata: a.metadata,
  }));
}

export async function getAgentByName(workspaceId: string, name: string) {
  const db = getDb();
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return null;

  // Get channels agent is in
  const memberships = await db
    .select({
      channelId: channelMembers.channelId,
      channelName: channels.name,
      role: channelMembers.role,
      joinedAt: channelMembers.joinedAt,
    })
    .from(channelMembers)
    .innerJoin(channels, eq(channelMembers.channelId, channels.id))
    .where(eq(channelMembers.agentId, agent.id));

  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    status: agent.status,
    persona: agent.persona,
    last_seen: agent.lastSeen.toISOString(),
    metadata: agent.metadata,
    channels: memberships.map((m) => ({
      id: m.channelId,
      name: m.channelName,
      role: m.role,
      joined_at: m.joinedAt.toISOString(),
    })),
  };
}

export async function updateAgent(
  workspaceId: string,
  name: string,
  updates: {
    status?: string;
    persona?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const db = getDb();
  const setClause: Record<string, unknown> = {};
  if (updates.status !== undefined) setClause.status = updates.status;
  if (updates.persona !== undefined) setClause.persona = updates.persona;
  if (updates.metadata !== undefined) setClause.metadata = updates.metadata;

  if (Object.keys(setClause).length === 0) {
    return getAgentByName(workspaceId, name);
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return null;

  const [updated] = await db
    .update(agents)
    .set(setClause)
    .where(eq(agents.id, agent.id))
    .returning();

  return {
    id: updated.id,
    name: updated.name,
    type: updated.type,
    status: updated.status,
    persona: updated.persona,
    last_seen: updated.lastSeen.toISOString(),
    metadata: updated.metadata,
  };
}

export async function deleteAgent(workspaceId: string, name: string) {
  const db = getDb();
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return false;

  await db.delete(agents).where(eq(agents.id, agent.id));
  return true;
}
