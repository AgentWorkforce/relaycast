import { and, eq, sql } from 'drizzle-orm';
import type { FleetCapability } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { agents, nodes } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';
import { runAtomic } from '../ports/database.js';

type Db = ReturnType<typeof getDb>;
type NodeRow = typeof nodes.$inferSelect;

export const NODE_LIVENESS_TTL_MS = 45_000;

/**
 * Recency window for the provider-attach duplicate check — how long a provider's
 * last frame keeps its binding "live" for the purpose of rejecting a competing
 * instance. The longest built-in node heartbeat cadence is 30 seconds; five
 * seconds of scheduling/network slack keeps those live connections inside the
 * window. A killed instance stops framing, so a restart can still supersede its
 * stale binding before the full {@link NODE_LIVENESS_TTL_MS}, which governs
 * roster/routing rather than attach arbitration.
 */
export const PROVIDER_ATTACH_LIVENESS_MS = 35_000;

/** The reject code for an attach that collides with a still-live provider instance. */
export type ProviderAttachConflictCode = 'provider_instance_conflict';

/** Inputs to {@link providerAttachDecision}: the incumbent binding vs. the registrant. */
export interface ProviderAttachDecisionInput {
  /** The incumbent binding's instance id, or `undefined` when nothing is bound. */
  existingInstanceId: string | undefined;
  /** Epoch-ms of the incumbent's last inbound frame. */
  existingLastSeen: number;
  /** The registering connection's instance id. */
  incomingInstanceId: string;
  /** Comparison clock; defaults to `Date.now()`. */
  now?: number;
}

/** The arbitration outcome for a provider attach. */
export type ProviderAttachDecision =
  | { conflict: false }
  | { conflict: true; code: ProviderAttachConflictCode };

/**
 * Provider-attach arbitration policy (spec §3.1). Given the incumbent binding's
 * instance id and last-frame time and the registrant's instance id, decide
 * whether the incoming attach collides with a still-live duplicate instance:
 *
 * - No incumbent binding — nothing to collide with; not a conflict.
 * - Same instance id — a reconnect/re-register, never a conflict.
 * - Different instance framed within {@link PROVIDER_ATTACH_LIVENESS_MS} — a live
 *   duplicate; reject with `provider_instance_conflict`.
 * - Different instance silent past the window — a stale binding the restart
 *   supersedes; not a conflict.
 *
 * The single source of truth for both the in-process `InProcessRealtime` adapter
 * and out-of-process socket owners (the relaycast-cloud NodeDO) that mirror the
 * decision against their own live sockets, so the policy can never silently
 * diverge between them.
 */
export function providerAttachDecision(input: ProviderAttachDecisionInput): ProviderAttachDecision {
  const { existingInstanceId, existingLastSeen, incomingInstanceId, now = Date.now() } = input;
  if (existingInstanceId === undefined) return { conflict: false };
  if (existingInstanceId === incomingInstanceId) return { conflict: false };
  if (now - existingLastSeen <= PROVIDER_ATTACH_LIVENESS_MS) {
    return { conflict: true, code: 'provider_instance_conflict' };
  }
  return { conflict: false };
}

export function isNodeLive(node: Pick<NodeRow, 'status' | 'lastHeartbeatAt'>, now = Date.now()): boolean {
  const age = node.lastHeartbeatAt ? now - node.lastHeartbeatAt.getTime() : null;
  return (
    node.status === 'online' &&
    age !== null &&
    age >= 0 &&
    age <= NODE_LIVENESS_TTL_MS
  );
}

/**
 * Whether a row sharing a machine_id may be reused by a new enrollment.
 *
 * This is deliberately STRICTER than `!isNodeLive(node)`, and the gap is the
 * point rather than an oversight.
 *
 * `lastHeartbeatAt` is always stamped server-side, never supplied by a caller,
 * so a heartbeat in the future means the server's own clock moved backwards —
 * a rollback, or a database restored from a snapshot. `isNodeLive` requires
 * `age >= 0`, so it reports such a node as NOT live even while that node is
 * still heartbeating normally. Reusing it would rename a running broker and
 * rotate its token: exactly the hijack the liveness gate exists to prevent,
 * occurring precisely when `isNodeLive` cannot be trusted to detect it.
 *
 * So an `online` row with a future heartbeat is treated as live. The cost is a
 * duplicate roster row, bounded at one per machine per rollback — the row that
 * enrollment creates instead is inserted with a null heartbeat, so the next
 * enrollment reuses that one rather than adding another. It also self-heals:
 * once the clock passes the stale future timestamp, the original row becomes
 * reusable again and oldest-first convergence collapses back onto it.
 */
export function isReusableForMachineMatch(
  node: Pick<NodeRow, 'status' | 'lastHeartbeatAt'>,
  now = Date.now(),
): boolean {
  if (isNodeLive(node, now)) return false;
  const heartbeat = node.lastHeartbeatAt?.getTime();
  return !(node.status === 'online' && heartbeat !== undefined && heartbeat > now);
}

export function nodeHasCapability(node: Pick<NodeRow, 'capabilities'>, capability: string): boolean {
  return Array.isArray(node.capabilities)
    && node.capabilities.some((item) => {
      if (typeof item === 'string') return item === capability;
      return (item as FleetCapability | undefined)?.name === capability;
    });
}

export function nodeHasCapacity(node: Pick<NodeRow, 'maxAgents' | 'activeAgents' | 'reservedAgents'>): boolean {
  return node.maxAgents === 0 || node.activeAgents + (node.reservedAgents ?? 0) < node.maxAgents;
}

function compareNodeCapacityLoad(a: NodeRow, b: NodeRow): number {
  // Prefer measured load over unknown load, then preserve the existing
  // utilization/count/name ordering. Unbounded nodes still participate via
  // activeAgents instead of masquerading as perfectly idle.
  return Number(b.loadReported) - Number(a.loadReported)
    || (a.load - b.load)
    || (a.activeAgents - b.activeAgents)
    || a.name.localeCompare(b.name);
}

function normalizeTarget(target: unknown): string | undefined {
  return typeof target === 'string' && target.trim().length > 0 ? target.trim() : undefined;
}

function normalizeCapability(actionName: string, input: Record<string, unknown>): string {
  const raw = input.capability ?? input.cli;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const value = raw.trim();
    return value.startsWith('spawn:') ? value : actionName === 'spawn' ? `spawn:${value}` : value;
  }
  return actionName;
}

export interface PlacementRequest {
  actionName: string;
  input?: Record<string, unknown>;
  callerId?: string | null;
  preferredNodeId?: string | null;
  excludeNodeIds?: string[];
}

export interface PlacementResult {
  node: NodeRow;
  capability: string;
  queued: boolean;
}

export async function reserveNodeCapacity(
  db: Db,
  workspaceId: string,
  nodeId: string,
): Promise<NodeRow | null> {
  const [updated] = await db
    .update(nodes)
    .set({
      reservedAgents: sql`coalesce(${nodes.reservedAgents}, 0) + 1`,
    })
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      eq(nodes.id, nodeId),
      eq(nodes.status, 'online'),
      eq(nodes.handlersLive, true),
      sql`(${nodes.maxAgents} = 0 OR (${nodes.activeAgents} + coalesce(${nodes.reservedAgents}, 0)) < ${nodes.maxAgents})`,
    ))
    .returning();
  return updated ?? null;
}

export async function releaseNodeCapacity(
  db: Db,
  workspaceId: string,
  nodeId: string,
  count = 1,
): Promise<void> {
  if (count <= 0) return;
  await db
    .update(nodes)
    .set({
      reservedAgents: sql`CASE WHEN coalesce(${nodes.reservedAgents}, 0) > ${count} THEN coalesce(${nodes.reservedAgents}, 0) - ${count} ELSE 0 END`,
    })
    .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, nodeId)));
}

export async function claimSpawnNode(
  db: Db,
  workspaceId: string,
  request: PlacementRequest,
): Promise<PlacementResult> {
  const input = request.input ?? {};
  const capability = normalizeCapability('spawn', input);
  const target = normalizeTarget(input.target_node ?? input.node ?? input.target);
  const excluded = new Set(request.excludeNodeIds ?? []);

  return runAtomic(db, async (tx) => {
    const chooseLiveCandidate = async (node: NodeRow | undefined): Promise<PlacementResult | null> => {
      if (!node) return null;
      if (!nodeHasCapability(node, capability) || excluded.has(node.id)) return null;
      if (!isNodeLive(node) || !node.handlersLive) return { node, capability, queued: true };
      const reserved = await reserveNodeCapacity(tx, workspaceId, node.id);
      if (!reserved) {
        throw codedError(`Node "${node.name}" is at capacity`, 'handler_unavailable', 503);
      }
      return { node: reserved, capability, queued: false };
    };

    if (request.preferredNodeId) {
      const [node] = await tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, request.preferredNodeId)));
      const claimed = await chooseLiveCandidate(node ?? undefined);
      if (claimed) return claimed;
      if (node && excluded.has(node.id)) {
        throw codedError(`Node "${node.name}" is unavailable for retry`, 'handler_unavailable', 503);
      }
      if (node && nodeHasCapability(node, capability)) {
        return { node, capability, queued: !isNodeLive(node) || !node.handlersLive };
      }
    }

    if (target === 'self') {
      if (!request.callerId) {
        throw codedError('target "self" requires an agent caller', 'placement_self_requires_agent', 400);
      }
      const [caller] = await tx
        .select({
          locationNodeId: agents.locationNodeId,
          locationType: agents.locationType,
        })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, request.callerId)));
      if (!caller || caller.locationType !== 'via_node' || !caller.locationNodeId) {
        throw codedError('caller is not attached to a node', 'placement_self_unavailable', 409);
      }
      const [node] = await tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, caller.locationNodeId)));
      if (!node) {
        throw codedError('caller node was not found', 'node_not_found', 404);
      }
      const claimed = await chooseLiveCandidate(node);
      if (claimed) return claimed;
      if (excluded.has(node.id)) {
        throw codedError(`Node "${node.name}" is unavailable for retry`, 'handler_unavailable', 503);
      }
      if (!nodeHasCapability(node, capability)) {
        throw codedError(`Node "${node.name}" does not provide ${capability}`, 'capability_mismatch', 409);
      }
      return { node, capability, queued: !isNodeLive(node) || !node.handlersLive };
    }

    if (target) {
      const [node] = await tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, target)));
      if (!node) {
        throw codedError(`Node "${target}" not found`, 'node_not_found', 404);
      }
      const claimed = await chooseLiveCandidate(node);
      if (claimed) return claimed;
      if (excluded.has(node.id)) {
        throw codedError(`Node "${node.name}" is unavailable for retry`, 'handler_unavailable', 503);
      }
      if (!nodeHasCapability(node, capability)) {
        throw codedError(`Node "${target}" does not provide ${capability}`, 'capability_mismatch', 409);
      }
      return { node, capability, queued: !isNodeLive(node) || !node.handlersLive };
    }

    const rows = await tx.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
    const eligible = rows
      .filter((node) =>
        !excluded.has(node.id) &&
        nodeHasCapability(node, capability) &&
        isNodeLive(node) &&
        node.handlersLive &&
        nodeHasCapacity(node),
      )
      .sort(compareNodeCapacityLoad);

    for (const node of eligible) {
      const reserved = await reserveNodeCapacity(tx, workspaceId, node.id);
      if (reserved) return { node: reserved, capability, queued: false };
    }

    throw codedError(`No live node provides ${capability}`, 'handler_unavailable', 503);
  });
}

export async function chooseNodeForAction(
  db: Db,
  workspaceId: string,
  request: PlacementRequest,
): Promise<PlacementResult> {
  const input = request.input ?? {};
  const capability = normalizeCapability(request.actionName, input);
  const target = normalizeTarget(input.target_node ?? input.node ?? input.target);
  const excluded = new Set(request.excludeNodeIds ?? []);

  if (request.preferredNodeId) {
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, request.preferredNodeId)));
    if (node && nodeHasCapability(node, capability) && !excluded.has(node.id)) {
      return {
        node,
        capability,
        queued: !isNodeLive(node) || !node.handlersLive,
      };
    }
    if (node && excluded.has(node.id)) {
      throw codedError(`Node "${node.name}" is unavailable for retry`, 'handler_unavailable', 503);
    }
  }

  if (target === 'self') {
    if (!request.callerId) {
      throw codedError('target "self" requires an agent caller', 'placement_self_requires_agent', 400);
    }
    const [caller] = await db
      .select({
        locationNodeId: agents.locationNodeId,
        locationType: agents.locationType,
      })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, request.callerId)));
    if (!caller || caller.locationType !== 'via_node' || !caller.locationNodeId) {
      throw codedError('caller is not attached to a node', 'placement_self_unavailable', 409);
    }
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, caller.locationNodeId)));
    if (!node) {
      throw codedError('caller node was not found', 'node_not_found', 404);
    }
    if (excluded.has(node.id)) {
      throw codedError(`Node "${node.name}" is unavailable for retry`, 'handler_unavailable', 503);
    }
    if (!nodeHasCapability(node, capability)) {
      throw codedError(`Node "${node.name}" does not provide ${capability}`, 'capability_mismatch', 409);
    }
    return {
      node,
      capability,
      queued: !isNodeLive(node) || !node.handlersLive,
    };
  }

  if (target) {
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.name, target)));
    if (!node) {
      throw codedError(`Node "${target}" not found`, 'node_not_found', 404);
    }
    if (excluded.has(node.id)) {
      throw codedError(`Node "${node.name}" is unavailable for retry`, 'handler_unavailable', 503);
    }
    if (!nodeHasCapability(node, capability)) {
      throw codedError(`Node "${target}" does not provide ${capability}`, 'capability_mismatch', 409);
    }
    return {
      node,
      capability,
      queued: !isNodeLive(node) || !node.handlersLive,
    };
  }

  const rows = await db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
  const eligible = rows
    .filter((node) =>
      !excluded.has(node.id) &&
      nodeHasCapability(node, capability) &&
      isNodeLive(node) &&
      node.handlersLive &&
      nodeHasCapacity(node),
    )
    .sort(compareNodeCapacityLoad);

  const node = eligible[0];
  if (!node) {
    throw codedError(`No live node provides ${capability}`, 'handler_unavailable', 503);
  }
  return { node, capability, queued: false };
}
