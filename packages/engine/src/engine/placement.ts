import { and, eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, nodes } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;
type NodeRow = typeof nodes.$inferSelect;

export const NODE_LIVENESS_TTL_MS = 45_000;

export function isNodeLive(node: Pick<NodeRow, 'status' | 'lastHeartbeatAt'>, now = Date.now()): boolean {
  return (
    node.status === 'online' &&
    !!node.lastHeartbeatAt &&
    now - node.lastHeartbeatAt.getTime() <= NODE_LIVENESS_TTL_MS
  );
}

export function nodeHasCapability(node: Pick<NodeRow, 'capabilities'>, capability: string): boolean {
  return Array.isArray(node.capabilities) && node.capabilities.includes(capability);
}

export function nodeHasCapacity(node: Pick<NodeRow, 'maxAgents' | 'activeAgents'>): boolean {
  return node.maxAgents === 0 || node.activeAgents < node.maxAgents;
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
}

export interface PlacementResult {
  node: NodeRow;
  capability: string;
  queued: boolean;
}

export async function chooseNodeForAction(
  db: Db,
  workspaceId: string,
  request: PlacementRequest,
): Promise<PlacementResult> {
  const input = request.input ?? {};
  const capability = normalizeCapability(request.actionName, input);
  const target = normalizeTarget(input.target_node ?? input.node ?? input.target);

  if (request.preferredNodeId) {
    const [node] = await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), eq(nodes.id, request.preferredNodeId)));
    if (node && nodeHasCapability(node, capability)) {
      return {
        node,
        capability,
        queued: !isNodeLive(node) || !node.handlersLive || !nodeHasCapacity(node),
      };
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
    if (!nodeHasCapability(node, capability)) {
      throw codedError(`Node "${node.name}" does not provide ${capability}`, 'capability_mismatch', 409);
    }
    return {
      node,
      capability,
      queued: !isNodeLive(node) || !node.handlersLive || !nodeHasCapacity(node),
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
    if (!nodeHasCapability(node, capability)) {
      throw codedError(`Node "${target}" does not provide ${capability}`, 'capability_mismatch', 409);
    }
    return {
      node,
      capability,
      queued: !isNodeLive(node) || !node.handlersLive || !nodeHasCapacity(node),
    };
  }

  const rows = await db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
  const eligible = rows
    .filter((node) =>
      nodeHasCapability(node, capability) &&
      isNodeLive(node) &&
      node.handlersLive &&
      nodeHasCapacity(node),
    )
    .sort((a, b) => (a.load - b.load) || (a.activeAgents - b.activeAgents) || a.name.localeCompare(b.name));

  const node = eligible[0];
  if (!node) {
    throw codedError(`No live node provides ${capability}`, 'handler_unavailable', 503);
  }
  return { node, capability, queued: false };
}
