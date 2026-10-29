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
/** Hosts bound RPC deadlines; unavailable authority returns unknown. The socket
 * owner independently rechecks its generation and receipt lease at final send. */
export interface NodeLivenessAuthority {
  inspect(workspaceId: string, nodeId: string): Promise<NodeLivenessSnapshot>;
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
