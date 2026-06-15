/**
 * Realtime coordination ports.
 *
 * These replace the Cloudflare Durable Objects that today sequence and fan out
 * events (ChannelDO, AgentDO, WorkspaceStreamDO). The engine expresses *intent*
 * ("broadcast this event to a channel"); an adapter decides how that happens:
 *
 *  - Node in-process adapter (OSS self-host): in-memory per-key counters +
 *    socket sets + a 500-event resync ring, all in one process.
 *  - Cloudflare DO adapter (cloud, lives in the cloud repo): translates each
 *    call back into `env.X_DO.idFromName(...).fetch(...)`.
 *
 * `RealtimeBus`, `ConnectionRegistry`, and `NodeConnectionRegistry` are intentionally separate interfaces
 * with different callers (routes drive the bus; the WS upgrade route drives the
 * registry) even though a single in-process adapter implements both over shared
 * state (an agent's seq counter and its socket set must live together).
 */

import type { FleetRelaycastToBrokerMessage } from '@relaycast/types';

/** A client-facing event payload, already passed through `transformForClient`. */
export type EngineEvent = Record<string, unknown>;

export interface BroadcastToChannelArgs {
  workspaceId: string;
  channelId: string;
  event: EngineEvent;
  /** Member agent IDs — used by the adapter to (re)initialize its member cache. */
  members?: string[];
  /** Muted member agent IDs — message-type events are suppressed for these. */
  mutedMembers?: string[];
}

export interface RealtimeBus {
  /**
   * Sequence and fan out an event to a channel's members.
   * Replaces ChannelDO `/broadcast` and its per-member AgentDO `/deliver` loop.
   *
   * MUST assign `channelSeq` strictly increasing per `(workspaceId, channelId)`,
   * even under concurrent callers.
   */
  broadcastToChannel(args: BroadcastToChannelArgs): Promise<{ channelSeq: number }>;

  /**
   * Deliver an event directly to specific agents (DMs, presence changes, action
   * push). Replaces `fanoutToAgents` + AgentDO `/deliver`. Each agent gets its
   * own monotonic `agentSeq` stamped (see {@link ConnectionRegistry.pushToAgent}).
   */
  deliverToAgents(args: {
    workspaceId: string;
    agentIds: string[];
    event: EngineEvent;
  }): Promise<void>;

  /**
   * Publish to the workspace-level stream consumed by workspace-key (`rk_live_`)
   * subscribers. Replaces `publishToWorkspaceStream` + WorkspaceStreamDO `/deliver`.
   */
  publishToWorkspaceStream(args: {
    workspaceId: string;
    event: EngineEvent;
  }): Promise<void>;

  /** Update the cached member list for a channel. Replaces ChannelDO `/update-members`. */
  setChannelMembers(workspaceId: string, channelId: string, members: string[]): Promise<void>;

  /** Update the cached muted list for a channel. Replaces ChannelDO `/update-muted`. */
  setChannelMuted(workspaceId: string, channelId: string, muted: string[]): Promise<void>;
}

export interface UpgradeArgs {
  request: Request;
  scope: 'agent' | 'workspace';
  workspaceId: string;
  /** Required when `scope === 'agent'`. */
  agentId?: string;
  /** Display name, used for presence events. */
  agentName?: string;
  origin: { surface: string; client: string; version: string };
  /** Cloud-only origin-actor path (`{app}/{type}[/{name}]`); defaults to `'unknown'`. */
  originActor?: string;
}

export interface ConnectionRegistry {
  /**
   * Upgrade an incoming request to a WebSocket bound to an agent or a workspace
   * stream. Returns the `Response` (status 101 + the socket). The adapter owns
   * the transport: Cloudflare uses `WebSocketPair` + hibernation; Node uses the
   * `ws` library and never evicts (single-process model).
   *
   * The resync protocol (`resync` / `resync_ack`, the 500-event ring, and the
   * DB-fallback replay via {@link replayMissedEvents}) is a wire-level detail the
   * client speaks to whichever side holds the socket, so it lives in the adapter.
   */
  upgrade(args: UpgradeArgs): Promise<Response>;

  /**
   * Push an event to one agent's live sockets, stamping a monotonic `agentSeq`
   * and buffering it for resync. Called by {@link RealtimeBus.deliverToAgents}
   * internally — the in-process adapter implements both ports over shared state.
   *
   * MUST assign `agentSeq` strictly increasing per `(workspaceId, agentId)`.
   */
  pushToAgent(
    workspaceId: string,
    agentId: string,
    event: EngineEvent,
  ): Promise<{ agentSeq: number }>;

  /** Force-close all of an agent's sockets (e.g. on token rotation). Replaces AgentDO `/force-disconnect`. */
  disconnectAgent(workspaceId: string, agentId: string): Promise<void>;
}

export interface NodeUpgradeArgs {
  request: Request;
  workspaceId: string;
  nodeId: string;
  nodeName: string;
  origin: { surface: string; client: string; version: string };
  originActor?: string;
}

export interface NodeConnectionRegistry {
  /**
   * Upgrade an incoming node-control request. Cloudflare adapters own the 101
   * response; the Node adapter handles upgrades in the HTTP server and exposes
   * attachNodeSocket instead.
   */
  upgradeNode(args: NodeUpgradeArgs): Promise<Response>;

  /** Push a typed fleet control message to the node's live broker connection. */
  sendToNode(
    workspaceId: string,
    nodeId: string,
    message: FleetRelaycastToBrokerMessage,
  ): Promise<boolean>;

  /** True when the node currently has a live control connection. */
  isNodeConnected(workspaceId: string, nodeId: string): boolean;

  /** Force-close all sockets for a node. */
  disconnectNode(workspaceId: string, nodeId: string): Promise<void>;

  /**
   * Flush any queued `action.invoke` frames to the node's live connection.
   * Must be invoked once the node is marked online (post node.register /
   * node.heartbeat) so capacity reservation for queued spawns can succeed.
   * Implementations serialize concurrent drains per node.
   */
  drainNode(workspaceId: string, nodeId: string): Promise<void>;
}
