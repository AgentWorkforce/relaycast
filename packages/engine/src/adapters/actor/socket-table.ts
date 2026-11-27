import type { ActorSql } from './database.js';
import type { NodeConnectionState } from '../node/realtime.js';

const TABLE = '_actor_sockets';

/**
 * The registry state of one control-plane socket, kept in the actor's
 * SQLite so a socket that outlives the actor's memory can be re-attached
 * on the next activation instead of closed.
 */
export const ACTOR_SOCKETS_TABLE = {
  name: TABLE,
  ddl: `CREATE TABLE IF NOT EXISTS ${TABLE} (
    socket_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('node', 'observer')),
    workspace_id TEXT NOT NULL,
    node_id TEXT,
    observer_token_id TEXT,
    provider_name TEXT,
    instance_id TEXT,
    delivery_mode TEXT CHECK (delivery_mode IN ('immediate', 'agent_scoped')),
    delivery_ready TEXT,
    caller_aware_actions TEXT NOT NULL DEFAULT '[]',
    last_seen INTEGER NOT NULL,
    attached_at INTEGER NOT NULL,
    device_token_hash TEXT
  )`,
  /** Columns added after the table first shipped; ensureActorSchema adds any a stored table lacks. */
  addedColumns: [
    // The device-token binding of the node token that opened the socket (engine/agentDevice.ts).
    { name: 'device_token_hash', ddl: 'device_token_hash TEXT' },
  ],
} as const;

export interface ActorSocketRow {
  socketId: string;
  kind: 'node' | 'observer';
  workspaceId: string;
  nodeId: string | null;
  observerTokenId: string | null;
  /** The provider bound at `node.register`; null while unbound. */
  providerName: string | null;
  instanceId: string | null;
  /** The delivery readiness `node.register` negotiated; null before one did. */
  deliveryMode: 'immediate' | 'agent_scoped' | null;
  /** Agent ids marked delivery-ready under `agent_scoped`; null otherwise. */
  deliveryReady: string[] | null;
  callerAwareActions: string[];
  lastSeen: number;
  attachedAt: number;
  /** The device-token binding of the node token that opened the socket; null when unbound. */
  deviceTokenHash: string | null;
}

interface RawRow {
  socket_id: string;
  kind: 'node' | 'observer';
  workspace_id: string;
  node_id: string | null;
  observer_token_id: string | null;
  provider_name: string | null;
  instance_id: string | null;
  delivery_mode: 'immediate' | 'agent_scoped' | null;
  delivery_ready: string | null;
  caller_aware_actions: string;
  last_seen: number;
  attached_at: number;
  device_token_hash: string | null;
}

const COLUMNS = 'socket_id, kind, workspace_id, node_id, observer_token_id, provider_name, instance_id, delivery_mode, delivery_ready, caller_aware_actions, last_seen, attached_at, device_token_hash';

function fromRaw(row: RawRow): ActorSocketRow {
  return {
    socketId: row.socket_id,
    kind: row.kind,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    observerTokenId: row.observer_token_id,
    providerName: row.provider_name,
    instanceId: row.instance_id,
    deliveryMode: row.delivery_mode,
    deliveryReady: row.delivery_ready === null ? null : (JSON.parse(row.delivery_ready) as string[]),
    callerAwareActions: JSON.parse(row.caller_aware_actions) as string[],
    lastSeen: Number(row.last_seen),
    attachedAt: Number(row.attached_at),
    deviceTokenHash: row.device_token_hash ?? null,
  };
}

/** The `_actor_sockets` rows: one per attached socket, a copy of the registry's state for it. */
export class ActorSocketTable {
  constructor(private readonly sql: ActorSql) {}

  /** Record a socket the registry attached. A reused id replaces the stale row. */
  insert(row: {
    socketId: string; kind: 'node' | 'observer'; workspaceId: string; nodeId?: string; observerTokenId?: string;
    deviceTokenHash?: string | null;
  }): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '[]', ?, ?, ?)
       ON CONFLICT(socket_id) DO UPDATE SET kind = excluded.kind, workspace_id = excluded.workspace_id,
         node_id = excluded.node_id, observer_token_id = excluded.observer_token_id, provider_name = NULL,
         instance_id = NULL, delivery_mode = NULL, delivery_ready = NULL, caller_aware_actions = '[]',
         last_seen = excluded.last_seen, attached_at = excluded.attached_at, device_token_hash = excluded.device_token_hash`,
      row.socketId, row.kind, row.workspaceId, row.nodeId ?? null, row.observerTokenId ?? null, now, now, row.deviceTokenHash ?? null,
    );
  }

  get(socketId: string): ActorSocketRow | undefined {
    const [row] = this.sql.exec(`SELECT ${COLUMNS} FROM ${TABLE} WHERE socket_id = ?`, socketId) as RawRow[];
    return row ? fromRaw(row) : undefined;
  }

  /** Every row, oldest attachment first (the order the registry was built in). */
  all(): ActorSocketRow[] {
    return (this.sql.exec(`SELECT ${COLUMNS} FROM ${TABLE} ORDER BY attached_at, rowid`) as RawRow[]).map(fromRaw);
  }

  delete(socketId: string): void {
    this.sql.exec(`DELETE FROM ${TABLE} WHERE socket_id = ?`, socketId);
  }

  /**
   * Copy a node connection's registry state into its row. A provider bound
   * here is unbound from any other socket of the node that held it (the
   * registry superseded that connection).
   */
  sync(socketId: string, state: NodeConnectionState): void {
    const ready = state.deliveryReadyAgentIds;
    this.sql.exec(
      `UPDATE ${TABLE} SET provider_name = ?, instance_id = ?, delivery_mode = ?, delivery_ready = ?, caller_aware_actions = ?, last_seen = ?
       WHERE socket_id = ?`,
      state.providerName ?? null,
      state.instanceId ?? null,
      ready === undefined ? null : ready === null ? 'immediate' : 'agent_scoped',
      ready ? JSON.stringify(ready) : null,
      JSON.stringify(state.callerAwareActions),
      state.lastSeen,
      socketId,
    );
    if (!state.providerName) return;
    this.sql.exec(
      `UPDATE ${TABLE} SET provider_name = NULL, instance_id = NULL, delivery_mode = NULL, delivery_ready = NULL, caller_aware_actions = '[]'
       WHERE provider_name = ? AND socket_id <> ? AND (workspace_id, node_id) = (SELECT workspace_id, node_id FROM ${TABLE} WHERE socket_id = ?)`,
      state.providerName, socketId, socketId,
    );
  }
}
