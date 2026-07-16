import { and, eq } from 'drizzle-orm';
import type { EngineDb } from './ports/index.js';
import { agents } from './db/schema.js';
import { deregisterAgentViaNode, directNodeIdForAgent } from './engine/node.js';

/** Options for {@link handleAgentDisconnect}. */
export interface HandleAgentDisconnectOptions {
  /**
   * When `true`, fully deregister a node-hosted agent: deactivate its active
   * `agent_node_bindings` row, release the node slot, and re-home
   * `location_node_id` to the implicit offline direct node. When `false`
   * (the default), the disconnect is treated as **presence intent only** — the
   * node binding and slot are left intact so the still-running PTY keeps
   * receiving deliveries. See issue #272.
   */
  deregister?: boolean;
}

/**
 * Disconnect an agent currently hosted by an explicit node when the caller has
 * no node-control socket frame to pass through `handleNodeControlMessage`.
 *
 * By default this is a no-op for the node binding (presence-only): callers that
 * genuinely intend to tear down the node hosting must pass
 * `{ deregister: true }`.
 */
export async function handleAgentDisconnect(
  db: EngineDb,
  workspaceId: string,
  agentId: string,
  opts: HandleAgentDisconnectOptions = {},
): Promise<boolean> {
  const [agent] = await db
    .select({
      locationType: agents.locationType,
      locationNodeId: agents.locationNodeId,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));

  if (
    !agent
    || agent.locationType !== 'via_node'
    || !agent.locationNodeId
    || agent.locationNodeId === directNodeIdForAgent(agentId)
  ) {
    return false;
  }

  if (!opts.deregister) {
    console.warn('[agent.disconnect] presence-only disconnect; skipping node deregistration', {
      workspaceId,
      agentId,
      nodeId: agent.locationNodeId,
    });
    return false;
  }

  console.warn('[agent.disconnect] deregistering node-hosted agent; re-homing to direct node', {
    workspaceId,
    agentId,
    fromNodeId: agent.locationNodeId,
    directNodeId: directNodeIdForAgent(agentId),
  });

  const disconnected = await deregisterAgentViaNode(
    db,
    workspaceId,
    agent.locationNodeId,
    { agent_id: agentId },
  );
  return disconnected !== null;
}
