import type { EngineDb, NodeConnectionRegistry } from './ports/index.js';
import { deliverPendingToNode } from './engine/delivery.js';

export { deliverPendingToNode } from './engine/delivery.js';

/**
 * Replay queued delivery frames for a node after its control connection has
 * been re-established outside the engine's `/v1/node/ws` request handler.
 *
 * Adapters that own node registration in another runtime, such as a Durable
 * Object, should call this after the node socket is live and the node/register
 * state has been written. The caller remains responsible for registration and
 * any action-queue draining it wants to perform.
 */
export async function handleNodeReconnect(
  db: EngineDb,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
): Promise<number> {
  return deliverPendingToNode(db, registry, workspaceId, nodeId);
}
