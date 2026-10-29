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
