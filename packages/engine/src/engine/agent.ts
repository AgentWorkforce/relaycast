import { eq, and, lt, inArray, isNull } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, channels, channelMembers, actions, deliveries, nodes } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { directNodeIdForAgent, ensureDirectNodeForAgent } from './node.js';

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
  const token = `at_live_${randomHex(16)}`;
  const tokenHash = await sha256Hex(token);

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
        // Set status explicitly: the column DEFAULT is the deprecated 'online'
        // on databases migrated before 0013, and SQLite can't ALTER a default.
        status: 'active',
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
      throw codedError(`Agent "${data.name}" already exists in this workspace`, 'agent_already_exists', 409);
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

  await ensureDirectNodeForAgent(db, workspaceId, agent);

  return {
    id: agentId,
    // Return the workspace id so a client that joined by workspace key (and
    // thus has no id locally) can record which workspace it registered into,
    // instead of falling back to an "unknown workspace" placeholder.
    workspace_id: workspaceId,
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
      // Mirror the GET /v1/deliveries replay queue: queued + delivered are the
      // non-terminal, still-pending states.
      .where(and(eq(deliveries.agentId, agent.id), inArray(deliveries.status, ['queued', 'delivered'])))
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
    workspace_id: workspaceId,
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

/**
 * Revoke an agent's credential without deleting anything.
 *
 * The token stops authenticating at the next request; the agent row, its
 * messages, the channels it created and the files it uploaded all stay exactly
 * where they are. This is the containment primitive `deleteAgent` cannot be:
 * that one fails outright on any seat with message history (four FKs onto
 * `agents(id)` are ON DELETE NO ACTION), and destroys history on the seats where
 * it does succeed.
 *
 * Idempotent by design. Re-revoking preserves the original `revoked_at` rather
 * than sliding it forward, so the timestamp remains an accurate record of when
 * containment actually took effect — an operator re-running the runbook must not
 * be able to rewrite that. `alreadyRevoked` lets the caller tell a fresh
 * revocation from a repeat without a second query.
 *
 * Note the deliberate scope limit: this invalidates the agent's own credential.
 * A node token that posts on this agent's behalf is a separate credential and
 * needs its own decision.
 */
export async function revokeAgentToken(
  db: Db,
  workspaceId: string,
  name: string,
): Promise<{ revokedAt: Date; alreadyRevoked: boolean } | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return null;

  if (agent.revokedAt) {
    return { revokedAt: agent.revokedAt, alreadyRevoked: true };
  }

  const revokedAt = new Date();
  await db
    .update(agents)
    .set({ revokedAt })
    .where(and(eq(agents.id, agent.id), isNull(agents.revokedAt)));

  // Re-read rather than trusting the write: under a concurrent revoke the
  // guarded UPDATE is a no-op and the stored timestamp is the other caller's.
  // The receipt has to report what the row actually holds.
  const [settled] = await db.select().from(agents).where(eq(agents.id, agent.id));
  return {
    revokedAt: settled?.revokedAt ?? revokedAt,
    alreadyRevoked: false,
  };
}

export async function deleteAgent(db: Db, workspaceId: string, name: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));

  if (!agent) return false;

  await db.delete(agents).where(eq(agents.id, agent.id));
  await db.delete(nodes).where(eq(nodes.id, directNodeIdForAgent(agent.id)));
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
