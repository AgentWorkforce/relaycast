import type { EngineDb } from './database.js';
/** A host-owned receipt lease. All timestamps are server epoch milliseconds. */
export interface NodeLivenessSnapshot {
  status: 'online' | 'offline' | 'unknown';
  providers: Array<{
    name: string;
    connection_id?: string;
    instance_id?: string;
    last_received_at: number;
    expires_at: number;
    live: boolean;
    handlers_live: boolean;
  }>;
}
/**
 * Longest interval an authority may let pass between durable checkpoints of a
 * node it reports online. A checkpoint is an accepted heartbeat: it stamps the
 * node row's `last_heartbeat_at`. Receipts may be held in
 * memory between checkpoints, but an authority that reports a node online must
 * have committed one within this interval plus the receipt lease. The engine
 * relies on this to bound authority probes for `status=online` node lists.
 */
export const NODE_LIVENESS_CHECKPOINT_INTERVAL_MS = 300_000;

/** Hosts bound RPC deadlines; unavailable authority returns unknown. The socket
 * owner independently rechecks its generation and receipt lease at final send.
 * Checkpoints follow {@link NODE_LIVENESS_CHECKPOINT_INTERVAL_MS}. */
export interface NodeLivenessAuthority {
  inspect(workspaceId: string, nodeId: string): Promise<NodeLivenessSnapshot>;
  /**
   * Durable state the node's socket owner may assert from memory changed
   * outside that node's own control frames — today a direct node's agent
   * binding, location or release. The owner re-reads it before asserting it
   * again. Called after the change commits; best effort.
   */
  invalidate?(workspaceId: string, nodeId: string): Promise<void>;
}

const authorities = new WeakMap<object, NodeLivenessAuthority>();
/** Bind all HTTP, maintenance and socket-owner database wrappers. */
export function configureNodeLiveness(db: EngineDb, authority?: NodeLivenessAuthority): void {
  if (authority) authorities.set(db, authority);
  else authorities.delete(db);
}
export function nodeLivenessAuthority(db: EngineDb): NodeLivenessAuthority | undefined {
  return authorities.get(db);
}
