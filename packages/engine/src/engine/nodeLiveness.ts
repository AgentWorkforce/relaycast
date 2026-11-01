import type { EngineDb } from '../ports/database.js';
import type { NodeLivenessSnapshot } from '../ports/nodeLiveness.js';
import { isNodeLive } from './placement.js';
import { isProviderLive } from './nodeProvider.js';
import { nodeLivenessAuthority } from '../ports/nodeLiveness.js';
export { configureNodeLiveness, nodeLivenessAuthority } from '../ports/nodeLiveness.js';
export async function inspectNodeLiveness(db: EngineDb, workspaceId: string, nodeId: string): Promise<NodeLivenessSnapshot | undefined> {
  const authority = nodeLivenessAuthority(db);
  if (!authority) return undefined;
  try { return await authority.inspect(workspaceId, nodeId); }
  catch { return { status: 'unknown', providers: [] }; }
}
/**
 * The agents' binding, location or release state changed: their direct nodes'
 * socket owners must stop acknowledging presence from memory. Runs after the
 * write commits, on the outer handle (a transaction handle carries no
 * authority). A lost call is bounded by the owner's durable checkpoint, which
 * re-reads the binding.
 */
export async function invalidateDirectPresence(db: EngineDb, workspaceId: string, agentIds: Iterable<string>): Promise<void> {
  const authority = nodeLivenessAuthority(db);
  if (!authority?.invalidate) return;
  await Promise.all([...new Set(agentIds)].map(agentId =>
    // directNodeIdForAgent, inlined: node.ts imports this module.
    authority.invalidate!(workspaceId, `node_direct_${agentId}`).catch(() => {})));
}
export async function nodeLive(db: EngineDb, row: { workspaceId: string; id: string; status: string; lastHeartbeatAt: Date | null }): Promise<boolean> {
  const snapshot = await inspectNodeLiveness(db, row.workspaceId, row.id);
  return snapshot ? snapshotOnline(snapshot) : isNodeLive(row);
}
export async function providerLive(db: EngineDb, workspaceId: string, nodeId: string, row: { name: string; status: string; handlersLive: boolean; lastHeartbeatAt: Date | null }): Promise<boolean> {
  const snapshot = await inspectNodeLiveness(db, workspaceId, nodeId);
  if (!snapshot) return isProviderLive(row);
  return snapshot.status === 'online' && snapshot.providers.some(p => p.name === row.name && p.live && p.handlers_live && p.expires_at > Date.now() && p.last_received_at <= Date.now());
}
/** Bound authority fanout instead of issuing one simultaneous RPC per catalog row. */
export async function filterAsync<T>(rows: T[], predicate: (row: T) => Promise<boolean>): Promise<T[]> {
  const kept: T[] = [];
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = rows.slice(offset, offset + 8);
    const decisions = await Promise.all(batch.map(predicate));
    batch.forEach((row, index) => { if (decisions[index]) kept.push(row); });
  }
  return kept;
}
/**
 * Inspect each distinct node once, keeping at most eight authority requests in
 * flight. A roster names the same node for every agent it hosts, so asking per
 * row repeats the same RPC; a snapshot is still read fresh for this decision
 * and is never kept past the call.
 */
export async function inspectNodesLiveness(
  db: EngineDb,
  workspaceId: string,
  nodeIds: Iterable<string>,
): Promise<Map<string, NodeLivenessSnapshot | undefined>> {
  const pending = [...new Set(nodeIds)];
  const snapshots = new Map<string, NodeLivenessSnapshot | undefined>();
  if (!nodeLivenessAuthority(db) || pending.length === 0) return snapshots;
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const nodeId = pending[next++];
      snapshots.set(nodeId, await inspectNodeLiveness(db, workspaceId, nodeId));
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
  return snapshots;
}
export async function nodeReady(db: EngineDb, row: { workspaceId: string; id: string; status: string; handlersLive: boolean; lastHeartbeatAt: Date | null }): Promise<boolean> {
  const snapshot = await inspectNodeLiveness(db, row.workspaceId, row.id);
  if (!snapshot) return isNodeLive(row) && row.handlersLive;
  return snapshot.status === 'online' && snapshot.providers.some(p => p.live && p.handlers_live && p.expires_at > Date.now() && p.last_received_at <= Date.now());
}

export function snapshotOnline(snapshot: NodeLivenessSnapshot): boolean {
  const now = Date.now();
  return snapshot.status === 'online' && snapshot.providers.some(p => p.live && p.expires_at > now && p.last_received_at <= now);
}

/** Unavailability cannot release an incumbent identity to another location. */
export async function nodeMayOwn(db: EngineDb, row: { workspaceId: string; id: string; status: string; lastHeartbeatAt: Date | null }): Promise<boolean> {
  const snapshot = await inspectNodeLiveness(db, row.workspaceId, row.id);
  return snapshot ? snapshot.status !== 'offline' : isNodeLive(row);
}
