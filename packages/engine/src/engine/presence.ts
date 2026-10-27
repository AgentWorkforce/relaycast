import { and, eq, ne, sql } from 'drizzle-orm';
import { agentNodeBindings, agents, nodeProviders, nodes } from '../db/schema.js';
import type { getDb } from '../db/index.js';
import type { PresenceTracker } from '../ports/presence.js';
import { RELEASED_AGENT_STATUS } from './agent.js';
import { isProviderLive } from './nodeProvider.js';
import { isNodeLive, NODE_LIVENESS_TTL_MS } from './placement.js';

type Db = ReturnType<typeof getDb>;

/**
 * Active bindings on nodes that might pass {@link isNodeLive}.
 *
 * One join for the whole roster: `idx_nodes_status_heartbeat` ranges the live
 * heartbeat window, then `idx_agent_node_bindings_node` seeks each node's
 * active bindings. The agent seek is its primary key, and the provider seek is
 * `node_providers_node_name_unique` for `agents.provider_name`. A nested
 * `EXISTS` on `idx_node_providers_node` tells a provider-less direct node from
 * a broker whose provider row is simply missing. SQLite stores heartbeats as
 * whole seconds, so the lower bound is up to 999ms wider than the millisecond
 * TTL; {@link isNodeLive} and {@link isProviderLive} are the decisions and drop
 * that extra second. The read does not write.
 */
export function nodeHostedPresenceQuery(db: Db, workspaceId: string, now: number) {
  const newestSecond = Math.floor(now / 1000);
  const oldestSecond = Math.floor((now - NODE_LIVENESS_TTL_MS) / 1000);
  // CROSS JOIN is not reordered by SQLite, so the live-node index stays the
  // outer loop and each node's bindings are a seek. INNER JOIN would let the
  // planner start at every active binding in the workspace.
  return db
    .select({
      // `nodes` and `agent_node_bindings` are indexed-by fragments, so their
      // columns are not join-tracked Column fields. mapWith keeps the driver
      // codecs (dates, text) the table columns already declare.
      agentId: sql`${agentNodeBindings.agentId}`.mapWith(agentNodeBindings.agentId),
      nodeLastHeartbeatAt: sql`${nodes.lastHeartbeatAt}`.mapWith(nodes.lastHeartbeatAt),
      nodeHasProviders: sql<number>`EXISTS (
        SELECT 1 FROM node_providers AS np
        WHERE np.workspace_id = ${nodes.workspaceId}
          AND np.node_id = ${nodes.id}
      )`.mapWith(Number),
      providerStatus: nodeProviders.status,
      providerHandlersLive: nodeProviders.handlersLive,
      providerLastHeartbeatAt: nodeProviders.lastHeartbeatAt,
    })
    .from(sql`${nodes} INDEXED BY idx_nodes_status_heartbeat`)
    .crossJoin(sql`${agentNodeBindings} INDEXED BY idx_agent_node_bindings_node`)
    .crossJoin(agents)
    .leftJoin(nodeProviders, and(
      eq(nodeProviders.workspaceId, workspaceId),
      eq(nodeProviders.nodeId, nodes.id),
      eq(nodeProviders.name, agents.providerName),
    ))
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      eq(nodes.status, 'online'),
      sql`${nodes.lastHeartbeatAt} >= ${oldestSecond}`,
      sql`${nodes.lastHeartbeatAt} <= ${newestSecond}`,
      eq(agentNodeBindings.workspaceId, workspaceId),
      eq(agentNodeBindings.nodeId, nodes.id),
      eq(agentNodeBindings.status, 'active'),
      eq(agents.workspaceId, workspaceId),
      eq(agents.id, agentNodeBindings.agentId),
      eq(agents.locationType, 'via_node'),
      eq(agents.locationNodeId, nodes.id),
      ne(agents.status, RELEASED_AGENT_STATUS),
    ));
}

type NodeHostedPresenceRow = {
  agentId: string;
  nodeLastHeartbeatAt: Date | null;
  nodeHasProviders: number | boolean;
  providerStatus: string | null;
  providerHandlersLive: boolean | null;
  providerLastHeartbeatAt: Date | null;
};

/**
 * A bound agent is online when its node is live and, on a node that has
 * provider rows, the provider named by `agents.provider_name` is live too.
 * Implicit direct nodes have no provider row; node liveness is the whole
 * signal. A sibling provider's heartbeat must not count an agent whose own
 * provider is disconnected or absent.
 */
export function nodeHostedAgentOnline(row: NodeHostedPresenceRow, now: number): boolean {
  if (!isNodeLive({ status: 'online', lastHeartbeatAt: row.nodeLastHeartbeatAt }, now)) return false;
  const hasProviders = row.nodeHasProviders === true || Number(row.nodeHasProviders) === 1;
  if (!hasProviders) return true;
  if (row.providerStatus == null || row.providerHandlersLive == null || row.providerLastHeartbeatAt == null) {
    return false;
  }
  return isProviderLive({
    status: row.providerStatus,
    handlersLive: row.providerHandlersLive,
    lastHeartbeatAt: row.providerLastHeartbeatAt,
  }, now);
}

/**
 * Get presence status for all agents in a workspace.
 * Queries the presence tracker for online agents and merges with the DB roster.
 * An agent located on a live node, with an active binding there, is online even
 * when it has never heartbeated over HTTP — unless it explicitly disconnected,
 * or its own provider (when the node has any) is not live.
 */
export async function getPresence(
  db: Db,
  presence: PresenceTracker,
  workspaceId: string,
  now = Date.now(),
): Promise<Array<{ agent_id: string; agent_name: string; status: 'online' | 'offline' }>> {
  const [allAgents, onlineIds, nodeHosted, suppressedIds] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      // Released rows are tombstones kept only so history stays attributable.
      // They are not roster members and must not appear as presence entries.
      .where(and(eq(agents.workspaceId, workspaceId), ne(agents.status, RELEASED_AGENT_STATUS))),
    presence.getOnline(workspaceId),
    nodeHostedPresenceQuery(db, workspaceId, now),
    presence.explicitlyDisconnected?.(workspaceId) ?? Promise.resolve([]),
  ]);

  if (allAgents.length === 0) return [];

  const onlineSet = new Set(onlineIds);
  const suppressed = new Set(suppressedIds);
  for (const row of nodeHosted) {
    if (suppressed.has(row.agentId)) continue;
    if (nodeHostedAgentOnline(row, now)) onlineSet.add(row.agentId);
  }

  return allAgents.map((agent) => ({
    agent_id: agent.id,
    agent_name: agent.name,
    status: onlineSet.has(agent.id) ? ('online' as const) : ('offline' as const),
  }));
}
