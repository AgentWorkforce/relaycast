import crypto from 'node:crypto';
import { eq, and, lt, or, sql, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, channels, channelMembers, actions, deliveries } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Detect unique constraint violations across D1, SQLite, and drizzle error shapes. */
function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; cause?: unknown };
  // Direct D1/SQLite error codes
  if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT') return true;
  // Message-based detection (D1 wraps as "D1_ERROR: UNIQUE constraint failed: ...")
  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase();
    if (msg.includes('unique constraint failed') || msg.includes('sqlite_constraint_unique')) return true;
  }
  // Drizzle may wrap the original error as .cause
  if (e.cause && isUniqueConstraintError(e.cause)) return true;
  return false;
}

export async function registerAgent(
  db: Db,
  workspaceId: string,
  data: {
    name: string;
    type?: string;
    persona?: string;
    metadata?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
  },
) {
  const agentId = generateId();
  const token = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Use INSERT directly and let the unique index (workspace_id, name) enforce
  // uniqueness. Avoids TOCTOU race between SELECT check and INSERT that causes
  // false "already exists" errors on D1 read replicas after delete+re-register.
  let agent;
  try {
    [agent] = await db
      .insert(agents)
      .values({
        id: agentId,
        workspaceId,
        name: data.name,
        handle: `@${data.name}`,
        type: data.type || 'agent',
        tokenHash,
        persona: data.persona ?? null,
        metadata: data.metadata ?? {},
        capabilities: data.capabilities ?? null,
      })
      .returning();
  } catch (insertErr: unknown) {
    // Unique constraint violation on (workspace_id, name) → agent already exists
    // D1 uses .code = 'SQLITE_CONSTRAINT_UNIQUE', drizzle may wrap in its own error,
    // and the message may contain 'UNIQUE constraint failed' or 'D1_ERROR: UNIQUE'
    if (isUniqueConstraintError(insertErr)) {
      const err = new Error(`Agent "${data.name}" already exists in this workspace`);
      Object.assign(err, { code: 'agent_already_exists', status: 409 });
      throw err;
    }
    throw insertErr;
  }

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
    handle: agent.handle ?? `@${agent.name}`,
    token,
    status: agent.status,
    capabilities: agent.capabilities ?? null,
    created_at: agent.createdAt.toISOString(),
  };
}

export async function listAgents(db: Db, workspaceId: string, status?: string) {
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
    handle: `@${a.name}`,
    type: a.type,
    status: a.status,
    persona: a.persona,
    capabilities: a.capabilities ?? null,
    created_at: a.createdAt.toISOString(),
    last_seen: a.lastSeen.toISOString(),
    metadata: a.metadata,
  }));
}

export async function getAgentByName(db: Db, workspaceId: string, name: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return null;

  // Get channels, actions, and pending deliveries in parallel
  const [memberships, allActions, pendingDeliveryRows] = await Promise.all([
    db
      .select({
        channelId: channelMembers.channelId,
        channelName: channels.name,
        role: channelMembers.role,
        joinedAt: channelMembers.joinedAt,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channelMembers.channelId, channels.id))
      .where(eq(channelMembers.agentId, agent.id)),
    db
      .select({
        id: actions.id,
        name: actions.name,
        description: actions.description,
        handlerAgentId: actions.handlerAgentId,
        availableTo: actions.availableTo,
        isActive: actions.isActive,
      })
      .from(actions)
      .where(and(eq(actions.workspaceId, workspaceId), eq(actions.isActive, true)))
      .limit(500),
    db
      .select({
        id: deliveries.id,
        messageId: deliveries.messageId,
        mode: deliveries.mode,
        reason: deliveries.reason,
        status: deliveries.status,
        createdAt: deliveries.createdAt,
      })
      .from(deliveries)
      .where(and(eq(deliveries.agentId, agent.id), eq(deliveries.status, 'accepted')))
      .orderBy(deliveries.createdAt)
      .limit(50),
  ]);

  const actionsProvided = allActions
    .filter((a) => a.handlerAgentId === agent.id)
    .map((a) => ({ id: a.id, name: a.name, description: a.description }));

  const actionsAvailableTo = allActions
    .filter((a) =>
      a.handlerAgentId !== agent.id &&
      (!a.availableTo || a.availableTo.length === 0 || a.availableTo.includes(agent.name)),
    )
    .map((a) => ({ id: a.id, name: a.name, description: a.description }));

  return {
    id: agent.id,
    name: agent.name,
    handle: agent.handle ?? `@${agent.name}`,
    type: agent.type,
    status: agent.status,
    persona: agent.persona,
    capabilities: agent.capabilities ?? null,
    created_at: agent.createdAt.toISOString(),
    last_seen: agent.lastSeen.toISOString(),
    metadata: agent.metadata,
    channels: memberships.map((m) => ({
      id: m.channelId,
      name: m.channelName,
      role: m.role,
      joined_at: m.joinedAt.toISOString(),
    })),
    actions_provided: actionsProvided,
    actions_available_to: actionsAvailableTo,
    pending_deliveries: pendingDeliveryRows.map((d) => ({
      id: d.id,
      message_id: d.messageId,
      mode: d.mode,
      reason: d.reason,
      status: d.status,
      created_at: d.createdAt.toISOString(),
    })),
  };
}

export async function updateAgent(
  db: Db,
  workspaceId: string,
  name: string,
  updates: {
    status?: string;
    persona?: string | null;
    metadata?: Record<string, unknown>;
    capabilities?: Record<string, unknown> | null;
  },
) {
  const setClause: Record<string, unknown> = {};
  if (updates.status !== undefined) setClause.status = updates.status;
  if (updates.persona !== undefined) setClause.persona = updates.persona;
  if (updates.metadata !== undefined) setClause.metadata = updates.metadata;
  if (updates.capabilities !== undefined) setClause.capabilities = updates.capabilities;

  if (Object.keys(setClause).length === 0) {
    return getAgentByName(db, workspaceId, name);
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
    handle: `@${updated.name}`,
    type: updated.type,
    status: updated.status,
    persona: updated.persona,
    capabilities: updated.capabilities ?? null,
    created_at: updated.createdAt.toISOString(),
    last_seen: updated.lastSeen.toISOString(),
    metadata: updated.metadata,
  };
}

export async function deleteAgent(db: Db, workspaceId: string, name: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return false;

  await db.delete(agents).where(eq(agents.id, agent.id));
  return true;
}

export async function touchLastSeen(db: Db, agentId: string): Promise<void> {
  await db
    .update(agents)
    .set({ lastSeen: new Date(), status: 'active' })
    .where(eq(agents.id, agentId));
}

export async function sweepStaleAgents(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const result = await db
    .update(agents)
    .set({ status: 'offline' })
    // Sweep both 'active' and legacy 'online' agents during the transition period
    .where(and(inArray(agents.status, ['active', 'online']), lt(agents.lastSeen, cutoff)))
    .returning({ id: agents.id });

  return result.length;
}

// === Spawn/Release (Agent Lifecycle) ===

export interface SpawnAgentData {
  name: string;
  cli: string;
  task: string;
  channel?: string;
  persona?: string;
  metadata?: Record<string, unknown>;
}

export interface SpawnAgentResult {
  id: string;
  name: string;
  handle: string;
  token: string;
  cli: string;
  task: string;
  channel: string | null;
  status: string;
  created_at: string;
  already_existed: boolean;
}

export async function spawnAgent(
  db: Db,
  workspaceId: string,
  data: SpawnAgentData,
): Promise<SpawnAgentResult> {
  // Check if agent already exists
  const [existing] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.name)));

  let agentId: string;
  let token: string;
  let createdAt: string;
  let alreadyExisted = false;

  if (existing) {
    // Agent exists - rotate token and update metadata
    alreadyExisted = true;
    agentId = existing.id;
    token = `at_live_${crypto.randomBytes(16).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Update agent with new token, set online, store spawn metadata
    const spawnMetadata = {
      ...(existing.metadata as Record<string, unknown> || {}),
      ...(data.metadata || {}),
      cli: data.cli,
      spawn: {
        cli: data.cli,
        task: data.task,
        spawned_at: new Date().toISOString(),
      },
    };

    await db
      .update(agents)
      .set({
        tokenHash,
        status: 'active',
        lastSeen: new Date(),
        persona: data.persona ?? existing.persona,
        metadata: spawnMetadata,
      })
      .where(eq(agents.id, agentId));

    createdAt = existing.createdAt.toISOString();
  } else {
    // Create new agent
    agentId = generateId();
    token = `at_live_${crypto.randomBytes(16).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const spawnMetadata = {
      ...(data.metadata || {}),
      cli: data.cli,
      spawn: {
        cli: data.cli,
        task: data.task,
        spawned_at: new Date().toISOString(),
      },
    };

    const [agent] = await db
      .insert(agents)
      .values({
        id: agentId,
        workspaceId,
        name: data.name,
        handle: `@${data.name}`,
        type: 'agent',
        tokenHash,
        status: 'active',
        persona: data.persona ?? null,
        metadata: spawnMetadata,
      })
      .returning();

    createdAt = agent.createdAt.toISOString();

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
      }).onConflictDoNothing();
    }
  }

  // Join specified channel if provided
  let joinedChannel: string | null = null;
  if (data.channel) {
    const channelName = data.channel.startsWith('#') ? data.channel.slice(1) : data.channel;
    const [channel] = await db
      .select()
      .from(channels)
      .where(
        and(eq(channels.workspaceId, workspaceId), eq(channels.name, channelName)),
      );

    if (channel && !channel.isArchived) {
      await db.insert(channelMembers).values({
        channelId: channel.id,
        agentId,
        role: 'member',
      }).onConflictDoNothing();
      joinedChannel = channel.name;
    }
  }

  return {
    id: agentId,
    name: data.name,
    handle: alreadyExisted ? (existing.handle ?? `@${data.name}`) : `@${data.name}`,
    token,
    cli: data.cli,
    task: data.task,
    channel: joinedChannel,
    status: 'active',
    created_at: createdAt,
    already_existed: alreadyExisted,
  };
}

export interface ReleaseAgentData {
  name: string;
  reason?: string;
  delete_agent?: boolean;
}

export interface ReleaseAgentResult {
  name: string;
  released: boolean;
  deleted: boolean;
  reason: string | null;
}

export async function releaseAgent(
  db: Db,
  workspaceId: string,
  data: ReleaseAgentData,
): Promise<ReleaseAgentResult | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.name)));

  if (!agent) {
    return null;
  }

  if (data.delete_agent) {
    // Delete the agent entirely
    await db.delete(agents).where(eq(agents.id, agent.id));
    return {
      name: data.name,
      released: true,
      deleted: true,
      reason: data.reason ?? null,
    };
  }

  // Mark as offline and clear spawn metadata
  const existingMetadata = (agent.metadata as Record<string, unknown>) || {};
  const { spawn: _spawn, cli: _cli, ...restMetadata } = existingMetadata;

  await db
    .update(agents)
    .set({
      status: 'offline',
      metadata: {
        ...restMetadata,
        release: {
          reason: data.reason ?? null,
          released_at: new Date().toISOString(),
        },
      },
    })
    .where(eq(agents.id, agent.id));

  return {
    name: data.name,
    released: true,
    deleted: false,
    reason: data.reason ?? null,
  };
}
