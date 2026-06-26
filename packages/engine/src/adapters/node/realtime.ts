import type {
  RealtimeBus,
  ConnectionRegistry,
  NodeConnectionRegistry,
  EngineEvent,
  UpgradeArgs,
  NodeUpgradeArgs,
} from '../../ports/realtime.js';
import type { ObserverToken } from '../../ports/auth.js';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { EngineDb } from '../../ports/database.js';
import { observerTokens } from '../../db/schema.js';
import { handleNodeControlMessage, markNodeOffline } from '../../engine/node.js';
import { drainNodeInvocations } from '../../engine/action.js';
import { observerAllowsEvent } from '../../engine/observerToken.js';
import type { InvocationCompletionDeps } from '../../engine/invocationCompletion.js';
import type { FleetRelaycastToBrokerMessage } from '@relaycast/types';

/**
 * Transport-agnostic socket the adapter writes to. The Node entrypoint adapts a
 * `ws` WebSocket to this shape; tests can pass a plain stub. Keeping the adapter
 * off any concrete socket type makes the realtime semantics unit-testable
 * without a network.
 */
export interface EngineSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Returned by attach helpers; the transport drives these on socket events. */
export interface SocketHandle {
  handleMessage(raw: string): Promise<void>;
  handleClose(): Promise<void>;
}

interface NodeConn {
  socket: EngineSocket;
}

interface WorkspaceConn {
  socket: EngineSocket;
  observerToken?: ObserverToken;
  /** Epoch ms of the last DB revalidation of {@link observerToken}. */
  observerCheckedAt?: number;
}

/**
 * How long a cached observer token snapshot is trusted before its live state
 * (revoked / narrowed / expired / deleted) is re-read from the DB on the next
 * publish. Bounds the window in which a revoked dashboard can keep receiving
 * events without forcing a DB read on every fanned-out event.
 */
const OBSERVER_TOKEN_REVALIDATE_MS = 5_000;

interface QueuedNodeMessage {
  key: string;
  message: Extract<FleetRelaycastToBrokerMessage, { type: 'action.invoke' }>;
}

/**
 * Single-process, in-memory implementation of the workspace observer stream and
 * node-control stream. Agent runtime traffic is intentionally node-only:
 * direct agents and broker-hosted agents both connect through `/v1/node/ws`.
 */
export class InProcessRealtime implements RealtimeBus, ConnectionRegistry, NodeConnectionRegistry {
  private readonly workspaceSockets = new Map<string, Set<WorkspaceConn>>();
  private readonly nodeSockets = new Map<string, NodeConn>();
  private readonly nodeQueues = new Map<string, QueuedNodeMessage[]>();
  /** Serializes drains per node so concurrent triggers never overlap. */
  private readonly nodeDrainChains = new Map<string, Promise<void>>();
  private nodeCompletionDeps: InvocationCompletionDeps | undefined;

  constructor(private readonly db: EngineDb) {}

  setNodeCompletionDeps(deps: InvocationCompletionDeps): void {
    this.nodeCompletionDeps = deps;
  }

  private nodeKey(workspaceId: string, nodeId: string): string {
    return `${workspaceId}:${nodeId}`;
  }

  async publishToWorkspaceStream(args: { workspaceId: string; event: EngineEvent }): Promise<void> {
    const set = this.workspaceSockets.get(args.workspaceId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(args.event);
    const now = Date.now();
    for (const conn of set) {
      // Re-read the observer token's live state periodically so a revoked,
      // narrowed, or expired token stops receiving events without waiting for a
      // reconnect. Without this the snapshot taken at attach time would be
      // authoritative forever.
      if (conn.observerToken && (conn.observerCheckedAt === undefined || now - conn.observerCheckedAt >= OBSERVER_TOKEN_REVALIDATE_MS)) {
        try {
          const fresh = await this.loadActiveObserverToken(args.workspaceId, conn.observerToken.id);
          if (!fresh) {
            set.delete(conn);
            try {
              conn.socket.close(1008, 'observer token revoked');
            } catch {
              // already closed
            }
            continue;
          }
          conn.observerToken = fresh;
          conn.observerCheckedAt = now;
        } catch {
          // Transient DB error: keep using the cached snapshot and retry on the
          // next event rather than dropping a legitimate observer.
        }
      }
      if (!observerAllowsEvent(conn.observerToken, args.event)) continue;
      try {
        conn.socket.send(data);
      } catch {
        // Socket may have closed between enumeration and send.
      }
    }
  }

  /**
   * Load the current, still-active observer token row by id, mirroring the
   * active/expiry checks the auth provider applies at connect time. Returns
   * `undefined` when the token has been revoked, has expired, or no longer
   * exists, so callers can fail closed.
   */
  private async loadActiveObserverToken(
    workspaceId: string,
    tokenId: string,
  ): Promise<ObserverToken | undefined> {
    const now = new Date();
    const [row] = await this.db
      .select()
      .from(observerTokens)
      .where(and(
        eq(observerTokens.workspaceId, workspaceId),
        eq(observerTokens.id, tokenId),
        eq(observerTokens.status, 'active'),
        or(isNull(observerTokens.expiresAt), gt(observerTokens.expiresAt, now)),
      ));
    return row;
  }

  /* ------------------------- ConnectionRegistry ------------------------ */

  async upgrade(_args: UpgradeArgs): Promise<Response> {
    // In Node the WebSocket upgrade is handled at the HTTP-server level by the
    // entrypoint (see entrypoints/node.ts), which calls attachWorkspaceSocket
    // directly. This method exists for interface parity.
    return new Response('WebSocket upgrade is handled by the Node server', { status: 426 });
  }

  /* ---------------------- NodeConnectionRegistry ---------------------- */

  async upgradeNode(_args: NodeUpgradeArgs): Promise<Response> {
    return new Response('WebSocket upgrade is handled by the Node server', { status: 426 });
  }

  async sendToNode(
    workspaceId: string,
    nodeId: string,
    message: FleetRelaycastToBrokerMessage,
  ): Promise<boolean> {
    const key = this.nodeKey(workspaceId, nodeId);
    const current = this.nodeSockets.get(key)?.socket;
    if (current) {
      try {
        current.send(JSON.stringify(message));
        return true;
      } catch {
        this.nodeSockets.delete(key);
      }
    }

    if (message.type !== 'action.invoke') {
      return false;
    }

    const queue = this.nodeQueues.get(key) ?? [];
    const queueKey = `${message.type}:${message.invocation_id}`;
    if (!queue.some((item) => item.key === queueKey)) {
      queue.push({ key: queueKey, message });
    }
    while (queue.length > 100) queue.shift();
    this.nodeQueues.set(key, queue);
    return true;
  }

  isNodeConnected(workspaceId: string, nodeId: string): boolean {
    return !!this.nodeSockets.get(this.nodeKey(workspaceId, nodeId));
  }

  async disconnectNode(workspaceId: string, nodeId: string): Promise<void> {
    const key = this.nodeKey(workspaceId, nodeId);
    const conn = this.nodeSockets.get(key);
    if (!conn) return;
    this.nodeSockets.delete(key);
    try {
      conn.socket.close(1000, 'force-disconnect');
    } catch {
      // already closed
    }
  }

  /* --------------------- Node transport attach helpers ----------------- */

  /** Register a live workspace-stream socket; returns handlers the transport drives. */
  attachWorkspaceSocket(workspaceId: string, socket: EngineSocket, observerToken?: ObserverToken): SocketHandle {
    let set = this.workspaceSockets.get(workspaceId);
    if (!set) {
      set = new Set();
      this.workspaceSockets.set(workspaceId, set);
    }
    const conn: WorkspaceConn = {
      socket,
      observerToken,
      // Trust the freshly authenticated snapshot until the first revalidation.
      observerCheckedAt: observerToken ? Date.now() : undefined,
    };
    set.add(conn);
    return {
      handleMessage: async (raw) => this.onWorkspaceMessage(socket, raw),
      handleClose: async () => {
        set!.delete(conn);
      },
    };
  }

  /** Register a live fleet node control socket; returns handlers the transport drives. */
  attachNodeSocket(workspaceId: string, nodeId: string, socket: EngineSocket): SocketHandle {
    const key = this.nodeKey(workspaceId, nodeId);
    const previous = this.nodeSockets.get(key)?.socket;
    this.nodeSockets.set(key, { socket });
    if (previous && previous !== socket) {
      try {
        previous.close(1000, 'superseded');
      } catch {
        // already closed
      }
    }
    const handle: SocketHandle = {
      handleMessage: async (raw) => handleNodeControlMessage({
        db: this.db,
        registry: this,
        completionDeps: this.nodeCompletionDeps,
        workspaceId,
        nodeId,
        socket,
        raw,
      }),
      handleClose: async () => {
        const conn = this.nodeSockets.get(key);
        if (conn?.socket === socket) {
          this.nodeSockets.delete(key);
          await markNodeOffline(this.db, this, workspaceId, nodeId).catch(() => {});
        }
      },
    };
    // Best-effort early flush (covers non-spawn frames that need no capacity);
    // the authoritative drain fires post node.register/heartbeat once the node
    // is marked online, so queued spawns can reserve capacity. See drainNode.
    void this.drainNode(workspaceId, nodeId);
    return handle;
  }

  /**
   * Public, serialized drain entrypoint. Concurrent calls for the same node are
   * chained so two drains never run at once (which could double-reserve spawn
   * capacity); each caller's promise resolves after its own drain pass runs.
   */
  drainNode(workspaceId: string, nodeId: string): Promise<void> {
    const key = this.nodeKey(workspaceId, nodeId);
    const prior = this.nodeDrainChains.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.drainNodeQueue(workspaceId, nodeId));
    this.nodeDrainChains.set(key, next);
    void next.finally(() => {
      if (this.nodeDrainChains.get(key) === next) this.nodeDrainChains.delete(key);
    });
    return next;
  }

  private async drainNodeQueue(workspaceId: string, nodeId: string): Promise<void> {
    const key = this.nodeKey(workspaceId, nodeId);
    const conn = this.nodeSockets.get(key)?.socket;
    if (!conn) return;
    await drainNodeInvocations(this.db, this, workspaceId, nodeId);
    this.nodeQueues.delete(key);
  }

  private async onWorkspaceMessage(socket: EngineSocket, raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as { type?: string };
      if (parsed.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    } catch {
      // ignore malformed frames
    }
  }
}
