import type { EngineDb, NodeConnectionRegistry } from './ports/index.js';
import { deliverPendingToNode, type DeliveryReplayDeps } from './engine/delivery.js';

export { deliverPendingToNode, type DeliveryReplayDeps } from './engine/delivery.js';

/**
 * Replay queued delivery frames for a node after its control connection has
 * been re-established outside the engine's `/v1/node/ws` request handler.
 *
 * Adapters that own node registration in another runtime, such as a Durable
 * Object, should call this after the node socket is live and the node/register
 * state has been written. The caller remains responsible for registration and
 * any action-queue draining it wants to perform. Pass `deps` (realtime + node
 * connections) so senders receive `delivery.delivered` for replayed rows;
 * without it the replay delivers but tells no sender.
 */
export async function handleNodeReconnect(
  db: EngineDb,
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  deps?: DeliveryReplayDeps,
): Promise<number> {
  return deliverPendingToNode(db, registry, workspaceId, nodeId, {}, deps);
}
