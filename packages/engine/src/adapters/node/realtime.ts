import type {
  RealtimeBus,
  ConnectionRegistry,
  NodeConnectionRegistry,
  EngineEvent,
  BroadcastToChannelArgs,
  UpgradeArgs,
  NodeUpgradeArgs,
} from '../../ports/realtime.js';
import { and, eq, sql } from 'drizzle-orm';
import type { EngineDb } from '../../ports/database.js';
import type { PresenceTracker } from '../../ports/presence.js';
import { actionInvocations } from '../../db/schema.js';
import { replayMissedEvents } from '../../engine/resyncQuery.js';
import { directNodeIdForAgent, handleNodeControlMessage, markDirectNodeOfflineForAgent, markNodeOffline } from '../../engine/node.js';
import { reserveNodeCapacity } from '../../engine/placement.js';
import { markDrainedInvocationDispatched } from '../../engine/action.js';
import { deliverPendingToNode } from '../../engine/delivery.js';
import type { InvocationCompletionDeps } from '../../engine/invocationCompletion.js';
import type { FleetRelaycastToBrokerMessage } from '@relaycast/types';

/** Matches the Cloudflare AgentDO resync ring size. */
const RESYNC_BUFFER_SIZE = 500;
const MESSAGE_EVENT_TYPES = new Set(['message.created', 'message', 'thread.reply']);

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

interface AgentConn {
  seq: number;
  sockets: Set<EngineSocket>;
  ring: Array<{ seq: number; payload: EngineEvent }>;
}

interface NodeConn {
  socket: EngineSocket;
}

interface QueuedNodeMessage {
  key: string;
  message: Extract<FleetRelaycastToBrokerMessage, { type: 'action.invoke' }>;
}

/** Backstop delay armed on a queued spawn whose capacity reservation deferred. */
const NODE_DRAIN_REQUEUE_RETRY_MS = 5_000;

interface ChannelState {
  seq: number;
  members: string[];
  muted: string[];
}

/**
 * Single-process, in-memory implementation of both {@link RealtimeBus} and
 * {@link ConnectionRegistry}, replacing the Cloudflare ChannelDO + AgentDO +
 * WorkspaceStreamDO. Per-agent `agent_seq` and per-channel `channel_seq` are
 * plain counters; JS single-threadedness makes the read-increment-write atomic
 * with no await between, so concurrent broadcasts stay strictly monotonic.
 *
 * Limitation: a single Node process only. Sequence counters, socket sets, and
 * the resync ring live in memory — horizontally scaling would need a shared
 * backend (Redis pub/sub for fanout, a shared counter store) plugged in behind
 * these same two interfaces.
 */
export class InProcessRealtime implements RealtimeBus, ConnectionRegistry, NodeConnectionRegistry {
  private readonly agents = new Map<string, AgentConn>();
  private readonly channels = new Map<string, ChannelState>();
  private readonly workspaceSockets = new Map<string, Set<EngineSocket>>();
  private readonly nodeSockets = new Map<string, NodeConn>();
  private readonly nodeQueues = new Map<string, QueuedNodeMessage[]>();
  /** Serializes drains per node so concurrent triggers never overlap. */
  private readonly nodeDrainChains = new Map<string, Promise<void>>();
  private presence: PresenceTracker | undefined;
  private nodeCompletionDeps: InvocationCompletionDeps | undefined;

  constructor(private readonly db: EngineDb) {}

  /** Wire the presence tracker after construction (ping → heartbeat, close → offline). */
  setPresence(presence: PresenceTracker): void {
    this.presence = presence;
  }

  setNodeCompletionDeps(deps: InvocationCompletionDeps): void {
    this.nodeCompletionDeps = deps;
  }

  private agentKey(workspaceId: string, agentId: string): string {
    return `${workspaceId}:${agentId}`;
  }

  private getAgent(workspaceId: string, agentId: string): AgentConn {
    const key = this.agentKey(workspaceId, agentId);
    let conn = this.agents.get(key);
    if (!conn) {
      conn = { seq: 0, sockets: new Set(), ring: [] };
      this.agents.set(key, conn);
    }
    return conn;
  }

  private getChannel(workspaceId: string, channelId: string): ChannelState {
    const key = `${workspaceId}:${channelId}`;
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { seq: 0, members: [], muted: [] };
      this.channels.set(key, ch);
    }
    return ch;
  }

  private nodeKey(workspaceId: string, nodeId: string): string {
    return `${workspaceId}:${nodeId}`;
  }

  /* ---------------------------- RealtimeBus ---------------------------- */

  /** Load channel members (and muted ids) from the DB when the cache is cold. */
  private async loadMembersFromDb(channelId: string): Promise<{ members: string[]; muted: string[] }> {
    const rows = await this.db.all<{ agent_id: string; is_muted: number }>(sql`
      SELECT agent_id, is_muted FROM channel_members WHERE channel_id = ${channelId}
    `);
    return {
      members: rows.map((r) => r.agent_id),
      muted: rows.filter((r) => r.is_muted === 1).map((r) => r.agent_id),
    };
  }

  async broadcastToChannel(args: BroadcastToChannelArgs): Promise<{ channelSeq: number }> {
    const { workspaceId, channelId, event, members, mutedMembers } = args;
    const ch = this.getChannel(workspaceId, channelId);

    // Cold-start member-cache init, mirroring ChannelDO.
    if (members && members.length > 0 && ch.members.length === 0) {
      ch.members = members;
    }
    if (mutedMembers) {
      ch.muted = mutedMembers;
    }
    // Fall back to the DB when the cache is empty (e.g. after a process restart),
    // matching ChannelDO's D1 reload so realtime delivery survives restarts.
    if (ch.members.length === 0) {
      try {
        const loaded = await this.loadMembersFromDb(channelId);
        if (loaded.members.length > 0) {
          ch.members = loaded.members;
          if (ch.muted.length === 0) ch.muted = loaded.muted;
        }
      } catch {
        // best-effort; proceed with whatever is cached
      }
    }

    const seq = ++ch.seq;
    const payload: EngineEvent = { ...event, channel_seq: seq };

    let deliverTo = ch.members;
    if (ch.muted.length > 0) {
      const type = typeof payload.type === 'string' ? payload.type : '';
      if (MESSAGE_EVENT_TYPES.has(type)) {
        const muted = new Set(ch.muted);
        deliverTo = ch.members.filter((id) => !muted.has(id));
      }
    }

    for (const agentId of deliverTo) {
      await this.pushToAgent(workspaceId, agentId, payload);
    }

    return { channelSeq: seq };
  }

  async deliverToAgents(args: { workspaceId: string; agentIds: string[]; event: EngineEvent }): Promise<void> {
    for (const agentId of args.agentIds) {
      await this.pushToAgent(args.workspaceId, agentId, args.event);
    }
  }

  async publishToWorkspaceStream(args: { workspaceId: string; event: EngineEvent }): Promise<void> {
    const set = this.workspaceSockets.get(args.workspaceId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(args.event);
    for (const socket of set) {
      try {
        socket.send(data);
      } catch {
        // Socket may have closed between enumeration and send.
      }
    }
  }

  async setChannelMembers(workspaceId: string, channelId: string, members: string[]): Promise<void> {
    this.getChannel(workspaceId, channelId).members = members;
  }

  async setChannelMuted(workspaceId: string, channelId: string, muted: string[]): Promise<void> {
    this.getChannel(workspaceId, channelId).muted = muted;
  }

  /* ------------------------- ConnectionRegistry ------------------------ */

  async upgrade(_args: UpgradeArgs): Promise<Response> {
    // In Node the WebSocket upgrade is handled at the HTTP-server level by the
    // entrypoint (see entrypoints/node.ts), which calls attachAgentSocket /
    // attachWorkspaceSocket directly. This method exists for interface parity.
    return new Response('WebSocket upgrade is handled by the Node server', { status: 426 });
  }

  async pushToAgent(
    workspaceId: string,
    agentId: string,
    event: EngineEvent,
  ): Promise<{ agentSeq: number }> {
    const conn = this.getAgent(workspaceId, agentId);
    const seq = ++conn.seq;
    const payload: EngineEvent = { ...event, agent_seq: seq };

    conn.ring.push({ seq, payload });
    if (conn.ring.length > RESYNC_BUFFER_SIZE) conn.ring.shift();

    const data = JSON.stringify(payload);
    for (const socket of conn.sockets) {
      try {
        socket.send(data);
      } catch {
        // Socket may have closed; the transport's close handler will clean up.
      }
    }
    return { agentSeq: seq };
  }

  async disconnectAgent(workspaceId: string, agentId: string): Promise<void> {
    const conn = this.agents.get(this.agentKey(workspaceId, agentId));
    if (!conn) return;
    for (const socket of [...conn.sockets]) {
      try {
        socket.close(1000, 'force-disconnect');
      } catch {
        // already closed
      }
      conn.sockets.delete(socket);
    }
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
    if (nodeId.startsWith('node_direct_') && message.type === 'deliver') {
      const agentId = message.agent_id || nodeId.slice('node_direct_'.length);
      const conn = this.agents.get(this.agentKey(workspaceId, agentId));
      if (!conn || conn.sockets.size === 0) return false;
      await this.pushToAgent(workspaceId, agentId, message);
      return true;
    }

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

  /** Register a live agent socket; returns handlers the transport drives. */
  attachAgentSocket(workspaceId: string, agentId: string, socket: EngineSocket): SocketHandle {
    const conn = this.getAgent(workspaceId, agentId);
    conn.sockets.add(socket);
    void deliverPendingToNode(this.db, this, workspaceId, directNodeIdForAgent(agentId)).catch(() => {});
    return {
      handleMessage: (raw) => this.onAgentMessage(workspaceId, agentId, socket, raw),
      handleClose: async () => {
        conn.sockets.delete(socket);
        if (conn.sockets.size === 0) {
          if (this.presence) {
            await this.presence.disconnect(workspaceId, agentId).catch(() => {});
          }
          if (conn.sockets.size !== 0) return;
          await markDirectNodeOfflineForAgent(this.db, workspaceId, agentId).catch(() => {});
        }
      },
    };
  }

  /** Register a live workspace-stream socket; returns handlers the transport drives. */
  attachWorkspaceSocket(workspaceId: string, socket: EngineSocket): SocketHandle {
    let set = this.workspaceSockets.get(workspaceId);
    if (!set) {
      set = new Set();
      this.workspaceSockets.set(workspaceId, set);
    }
    set.add(socket);
    return {
      handleMessage: async (raw) => this.onWorkspaceMessage(socket, raw),
      handleClose: async () => {
        set!.delete(socket);
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
    const queued = this.nodeQueues.get(key);
    if (!queued || queued.length === 0) return;

    const remaining: QueuedNodeMessage[] = [];
    for (const item of queued) {
      try {
        const [row] = await this.db
          .select({
            dispatchedNodeId: actionInvocations.dispatchedNodeId,
            status: actionInvocations.status,
            spawnReservedAt: actionInvocations.spawnReservedAt,
          })
          .from(actionInvocations)
          .where(and(eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.id, item.message.invocation_id)));
        if (!row) continue;
        if (row.dispatchedNodeId !== nodeId || (row.status !== 'dispatched' && row.status !== 'pending')) continue;
        const isSpawnAction = item.message.action === 'spawn' || item.message.action.startsWith('spawn:');
        if (isSpawnAction && !row.spawnReservedAt) {
          const reserved = await reserveNodeCapacity(this.db, workspaceId, nodeId);
          if (!reserved) {
            // Node not yet online (drain ran before register) or genuinely at
            // capacity: keep the frame queued, but arm retry_after_at so the
            // dispatch sweeper reschedules this pending spawn as a backstop if
            // no later drain trigger (register/heartbeat) delivers it first.
            await this.db
              .update(actionInvocations)
              .set({ retryAfterAt: new Date(Date.now() + NODE_DRAIN_REQUEUE_RETRY_MS) })
              .where(and(
                eq(actionInvocations.workspaceId, workspaceId),
                eq(actionInvocations.id, item.message.invocation_id),
                eq(actionInvocations.status, 'pending'),
              ));
            remaining.push(item);
            continue;
          }
          await this.db
            .update(actionInvocations)
            .set({ spawnReservedAt: new Date() })
            .where(and(eq(actionInvocations.workspaceId, workspaceId), eq(actionInvocations.id, item.message.invocation_id)));
        }
        conn.send(JSON.stringify(item.message));
        // The frame is now actually on the wire: move the invocation out of the
        // queued `pending` state into `dispatched` via the shared transition so
        // the dispatch-timeout sweep/reschedule covers it like a live dispatch.
        await markDrainedInvocationDispatched(this.db, workspaceId, item.message.invocation_id, nodeId);
      } catch {
        remaining.push(item);
        remaining.push(...queued.slice(queued.indexOf(item) + 1));
        break;
      }
    }
    if (remaining.length > 0) {
      this.nodeQueues.set(key, remaining);
    } else {
      this.nodeQueues.delete(key);
    }
  }

  private async onAgentMessage(
    workspaceId: string,
    agentId: string,
    socket: EngineSocket,
    raw: string,
  ): Promise<void> {
    let parsed: { type?: string; last_seen_seq?: number; since?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (parsed.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      if (this.presence) {
        await this.presence.heartbeat(workspaceId, agentId).catch(() => {});
      }
      return;
    }

    if (parsed.type === 'resync' && typeof parsed.last_seen_seq === 'number') {
      const { replayed, gapDetected } = this.replayBuffered(workspaceId, agentId, socket, parsed.last_seen_seq);

      let dbReplayed = 0;
      if (gapDetected && parsed.since) {
        try {
          const events = await replayMissedEvents(this.db, agentId, workspaceId, parsed.since);
          for (const e of events) {
            try {
              socket.send(JSON.stringify(e));
              dbReplayed++;
            } catch {
              break;
            }
          }
        } catch {
          // DB replay best-effort; the ack still reports buffered replay.
        }
      }

      socket.send(JSON.stringify({
        type: 'resync_ack',
        last_seen_seq: parsed.last_seen_seq,
        current_seq: this.getAgent(workspaceId, agentId).seq,
        replayed: replayed + dbReplayed,
        gap_detected: gapDetected,
      }));
    }
  }

  private async onWorkspaceMessage(socket: EngineSocket, raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as { type?: string };
      if (parsed.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    } catch {
      // ignore malformed frames
    }
  }

  private replayBuffered(
    workspaceId: string,
    agentId: string,
    socket: EngineSocket,
    lastSeen: number,
  ): { replayed: number; gapDetected: boolean } {
    const conn = this.getAgent(workspaceId, agentId);
    const currentSeq = conn.seq;
    if (lastSeen >= currentSeq) {
      return { replayed: 0, gapDetected: false };
    }

    const oldestBuffered = conn.ring.length > 0 ? conn.ring[0].seq : currentSeq + 1;
    const gapDetected = lastSeen < oldestBuffered - 1;

    let replayed = 0;
    for (const item of conn.ring) {
      if (item.seq > lastSeen) {
        try {
          socket.send(JSON.stringify(item.payload));
          replayed++;
        } catch {
          break;
        }
      }
    }
    return { replayed, gapDetected };
  }
}
