import { and, eq, ne, sql } from 'drizzle-orm';
import { agentNodeBindings, agents, nodes } from '../db/schema.js';
import type { getDb } from '../db/index.js';
import type { PresenceTracker } from '../ports/presence.js';
import { RELEASED_AGENT_STATUS } from './agent.js';
import { isNodeLive, NODE_LIVENESS_TTL_MS } from './placement.js';

type Db = ReturnType<typeof getDb>;

/**
 * Active bindings on nodes that might pass {@link isNodeLive}.
 *
 * One join for the whole roster: `idx_nodes_status_heartbeat` ranges the live
 * heartbeat window, then `idx_agent_node_bindings_node` seeks each node's
 * active bindings. SQLite stores the heartbeat as whole seconds, so the lower
 * bound is up to 999ms wider than the millisecond TTL; {@link isNodeLive} is
 * the decision and drops that extra second. The read does not write.
 */
export function nodeHostedPresenceQuery(db: Db, workspaceId: string, now: number) {
  const newestSecond = Math.floor(now / 1000);
  const oldestSecond = Math.floor((now - NODE_LIVENESS_TTL_MS) / 1000);
  return db
    .select({
      agentId: agentNodeBindings.agentId,
      lastHeartbeatAt: nodes.lastHeartbeatAt,
    })
    .from(nodes)
    .innerJoin(agentNodeBindings, and(
      eq(agentNodeBindings.workspaceId, workspaceId),
      eq(agentNodeBindings.nodeId, nodes.id),
      eq(agentNodeBindings.status, 'active'),
    ))
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      eq(nodes.status, 'online'),
      sql`${nodes.lastHeartbeatAt} >= ${oldestSecond}`,
      sql`${nodes.lastHeartbeatAt} <= ${newestSecond}`,
    ));
}

/**
 * Get presence status for all agents in a workspace.
 * Queries the presence tracker for online agents and merges with the DB roster.
 * An agent with an active binding on a node that passes {@link isNodeLive} is
 * online even when it has never heartbeated over HTTP.
 */
export async function getPresence(
  db: Db,
  presence: PresenceTracker,
  workspaceId: string,
  now = Date.now(),
): Promise<Array<{ agent_id: string; agent_name: string; status: 'online' | 'offline' }>> {
  const [allAgents, onlineIds, nodeHosted] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      // Released rows are tombstones kept only so history stays attributable.
      // They are not roster members and must not appear as presence entries.
      .where(and(eq(agents.workspaceId, workspaceId), ne(agents.status, RELEASED_AGENT_STATUS))),
    presence.getOnline(workspaceId),
    nodeHostedPresenceQuery(db, workspaceId, now),
  ]);

  if (allAgents.length === 0) return [];

  const onlineSet = new Set(onlineIds);
  for (const row of nodeHosted) {
    if (isNodeLive({ status: 'online', lastHeartbeatAt: row.lastHeartbeatAt }, now)) {
      onlineSet.add(row.agentId);
    }
  }

  return allAgents.map((agent) => ({
    agent_id: agent.id,
    agent_name: agent.name,
    status: onlineSet.has(agent.id) ? ('online' as const) : ('offline' as const),
  }));
}
