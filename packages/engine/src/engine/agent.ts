import { eq, and, gt, lt, ne, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agentCredentialClaims, agents, agentNodeBindings, channels, channelMembers, actions, deliveries, nodes } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { directNodeIdForAgent } from './node.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import {
  bindingColumns,
  credentialClaimColumns,
  type AgentCredentialAuthorityDecision,
} from './agentCredentialAuthority.js';

type Db = ReturnType<typeof getDb>;

/** How long an authenticated agent can be silent before it is no longer present. */
export const AGENT_LIVENESS_TTL_MS = 5 * 60 * 1000;

/**
 * How long an agent must be silent before a DIFFERENT node may reclaim its
 * name and overwrite its `token_hash` (`registerAgentViaNode`).
 *
 * Deliberately NOT `AGENT_LIVENESS_TTL_MS`, and deliberately not the `status`
 * column. Presence and identity are different questions: "should the roster
 * show this agent as here" is cheap to get wrong and self-corrects on the next
 * heartbeat, whereas "may another node take this name and be issued a working
 * token for it" is a credential handover that cannot be undone. They must not
 * share a threshold, and they must not share a field that a roster read can
 * write — gating identity on `status` meant a stale-agent sweep, triggered by
 * an `agent list`, silently made records claimable.
 *
 * 24h chosen against measured production data (relaycast-cloud, 2026-08-07):
 * of the 1,578 records whose reclaim eligibility this governs, silence was
 * <5m: 5, 5m-24h: 9, 1d-7d: 1, >7d: 1,568. So 99.4% have been silent over a
 * week and a 24h grace costs essentially nothing steady-state (1,569 eligible
 * vs 1,578) while protecting the ~14 identities a human would still call live.
 *
 * Lower this only with fresh measurements — shortening it converts live agents
 * into reclaimable ones.
 */
export const AGENT_RECLAIM_GRACE_MS = 24 * 60 * 60 * 1000;

type AgentPresenceRow = Pick<typeof agents.$inferSelect, 'status' | 'lastSeen'>;

/**
 * Status of a row whose name has been released back to the workspace
 * (relaycast#309). The row is retained so the four RESTRICT foreign keys to
 * `agents.id` stay valid and the agent's history keeps its author; only the
 * name is freed. A released row is not a roster member and never serves as a
 * delivery target.
 */
export const RELEASED_AGENT_STATUS = 'released';

/**
 * Marker separating a released agent's original name from its tombstone
 * suffix. Reserved: registration rejects it, which is what makes
 * {@link releasedAgentName} collision-free (see {@link assertRegistrableAgentName}).
 */
export const RELEASED_NAME_MARKER = '#released-';

/**
 * Tombstone name for a released agent.
 *
 * Keyed on the agent id, not a timestamp: the release runs inside an atomic
 * batch where a `UNIQUE(workspace_id, name)` violation aborts the WHOLE unit
 * rather than failing just this statement — which is the exact defect the
 * tombstone exists to avoid. A timestamped name can collide; an id-keyed one
 * cannot, because the id is already unique per workspace.
 *
 * That argument only holds while no ordinary agent can occupy this namespace.
 * Agent names are otherwise arbitrary strings, so without the registration
 * guard a caller could pre-register `<name>#released-<victimId>` and make the
 * victim's release abort. Hence the reserved marker.
 */
export function releasedAgentName(name: string, agentId: string): string {
  return `${name}${RELEASED_NAME_MARKER}${agentId}`;
}

/**
 * Reject names that would land in the reserved tombstone namespace.
 *
 * Called on every registration path. Without it the release path is not
 * atomic-safe: see {@link releasedAgentName}.
 */
export function assertRegistrableAgentName(name: string): void {
  if (name.includes(RELEASED_NAME_MARKER)) {
    throw codedError(
      `Agent name "${name}" is reserved: "${RELEASED_NAME_MARKER}" marks a released agent`,
      'invalid_agent_name',
      400,
    );
  }
}

/**
 * Resolve the public presence status from server-observed activity. Persisted
 * `active` is only the last reported state; it is not proof of current life.
 */
export function effectiveAgentStatus(agent: AgentPresenceRow, now = Date.now()): string {
  // A client-supplied/faulty clock must not create a negative age. The
  // workspace sweep durably clamps future timestamps to its server clock so
  // they subsequently expire normally after one TTL window.
  const observedAt = Math.min(agent.lastSeen.getTime(), now);
  if (
    (agent.status === 'active' || agent.status === 'online')
    && now - observedAt > AGENT_LIVENESS_TTL_MS
  ) {
    return 'offline';
  }
  return agent.status === 'online' ? 'active' : agent.status;
}

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
  credentialAuthority: AgentCredentialAuthorityDecision,
) {
  assertRegistrableAgentName(data.name);
  const agentId = generateId();
  const token = `at_live_${randomHex(16)}`;
  const tokenHash = await sha256Hex(token);
  const directNodeId = directNodeIdForAgent(agentId);
  const directNodeTokenHash = await sha256Hex(`implicit_direct:${workspaceId}:${agentId}:${randomHex(16)}`);
  const now = new Date();

  const [generalChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, 'general')));

  // Register the identity, implicit direct node, active binding, and default
  // membership as one atomic unit. A failed direct-node write must not leave a
  // live but undispatchable roster row behind.
  let agent;
  try {
    const results = await runAtomicWrites(db, (writeDb) => {
      const writes: AtomicWrite[] = [];
      const credentialClaim = credentialClaimColumns(
        workspaceId,
        data.name,
        credentialAuthority,
      );
      if (credentialClaim) {
        writes.push(writeDb.insert(agentCredentialClaims).values(credentialClaim).onConflictDoNothing());
      }
      writes.push(writeDb.insert(nodes).values({
        id: directNodeId,
        workspaceId,
        name: `direct-${agentId}`,
        tokenHash: directNodeTokenHash,
        kind: 'ws',
        role: 'direct',
        deliveryAdapter: 'ws.node.v1',
        deliveryConfig: { implicit: true, agent_id: agentId, agent_name: data.name },
        capabilities: [],
        maxAgents: 1,
        activeAgents: 1,
        tags: ['implicit', 'direct'],
        version: 'implicit',
        status: 'offline',
        handlersLive: false,
        load: 0,
        lastHeartbeatAt: null,
        createdAt: now,
      }), writeDb
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
          locationType: 'via_node',
          locationNodeId: directNodeId,
          ...bindingColumns(credentialAuthority),
        })
        .returning());

      if (generalChannel) {
        writes.push(writeDb.insert(channelMembers).values({
          channelId: generalChannel.id,
          agentId,
          role: 'member',
        }));
      }

      writes.push(writeDb.insert(agentNodeBindings).values({
        id: `anb_${generateId()}`,
        workspaceId,
        agentId,
        nodeId: directNodeId,
        status: 'active',
        sessionRef: null,
        priority: 0,
        createdAt: now,
        updatedAt: now,
      }));
      return writes;
    });
    const agentResultIndex = credentialClaimColumns(workspaceId, data.name, credentialAuthority)
      ? 2
      : 1;
    [agent] = results[agentResultIndex] as (typeof agents.$inferSelect)[];
  } catch (insertErr: unknown) {
    // Unique constraint violation on (workspace_id, name) → agent already exists
    // D1 uses .code = 'SQLITE_CONSTRAINT_UNIQUE', drizzle may wrap in its own error,
    // and the message may contain 'UNIQUE constraint failed' or 'D1_ERROR: UNIQUE'
    if (isUniqueConstraintError(insertErr)) {
      throw codedError(`Agent "${data.name}" already exists in this workspace`, 'agent_already_exists', 409);
    }
    throw insertErr;
  }

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
  // Keep the durable state aligned as a cleanup side effect, while still
  // deriving below so correctness never depends on a cron/sweep having run.
  await sweepStaleAgents(db, workspaceId);
  const rows = await db
    .select()
    .from(agents)
    // Released rows are tombstones retained only to keep history attributable;
    // they are not roster members, so `agent list` must not fill with them.
    .where(and(eq(agents.workspaceId, workspaceId), ne(agents.status, RELEASED_AGENT_STATUS)));
  const requestedStatus = status === 'online' ? 'active' : status;

  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    handle: `@${a.name}`,
    type: a.type,
    status: effectiveAgentStatus(a),
    persona: a.persona,
    capabilities: a.capabilities ?? null,
    created_at: a.createdAt.toISOString(),
    last_seen: a.lastSeen.toISOString(),
    metadata: a.metadata,
  })).filter((agent) => !requestedStatus || requestedStatus === 'all' || agent.status === requestedStatus);
}

export async function getAgentByName(db: Db, workspaceId: string, name: string) {
  // Match roster reads: detail consumers should observe both derived and
  // durable presence consistently within this workspace.
  await sweepStaleAgents(db, workspaceId);
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
    status: effectiveAgentStatus(agent),
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
    status: effectiveAgentStatus(updated),
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
  await db.delete(nodes).where(eq(nodes.id, directNodeIdForAgent(agent.id)));
  return true;
}

export async function touchLastSeen(db: Db, agentId: string): Promise<void> {
  await db
    .update(agents)
    .set({ lastSeen: new Date(), status: 'active' })
    .where(eq(agents.id, agentId));
}

export async function sweepStaleAgents(db: Db, workspaceId?: string): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AGENT_LIVENESS_TTL_MS);
  const future = and(
    inArray(agents.status, ['active', 'online']),
    gt(agents.lastSeen, now),
    ...(workspaceId ? [eq(agents.workspaceId, workspaceId)] : []),
  );
  const normalized = await db
    .update(agents)
    .set({ lastSeen: now })
    .where(future)
    .returning({ id: agents.id });
  const stale = and(
    inArray(agents.status, ['active', 'online']),
    lt(agents.lastSeen, cutoff),
    ...(workspaceId ? [eq(agents.workspaceId, workspaceId)] : []),
  );

  const result = await db
    .update(agents)
    .set({ status: 'offline' })
    // Sweep both 'active' and legacy 'online' agents during the transition period
    .where(stale)
    .returning({ id: agents.id });

  return normalized.length + result.length;
}
