import { and, eq } from 'drizzle-orm';
import type { EngineDb } from './ports/index.js';
import { agents } from './db/schema.js';
import { deregisterAgentViaNode, directNodeIdForAgent } from './engine/node.js';

/**
 * Disconnect an agent currently hosted by an explicit node when the caller has
 * no node-control socket frame to pass through `handleNodeControlMessage`.
 */
export async function handleAgentDisconnect(
  db: EngineDb,
  workspaceId: string,
  agentId: string,
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

  const disconnected = await deregisterAgentViaNode(
    db,
    workspaceId,
    agent.locationNodeId,
    { agent_id: agentId },
  );
  return disconnected !== null;
}
