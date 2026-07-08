/**
 * Realtime coordination ports.
 *
 * These replace the Cloudflare Durable Objects that own live streams. The
 * engine expresses *intent* ("publish this observer event" or "send this node
 * frame"); an adapter decides how that happens:
 *
 *  - Node in-process adapter (OSS self-host): in-memory workspace observer
 *    sockets and node-control sockets, all in one process.
 *  - Cloudflare DO adapter (cloud, lives in the cloud repo): translates each
 *    call back into `env.X_DO.idFromName(...).fetch(...)`.
 *
 * `RealtimeBus`, `ConnectionRegistry`, and `NodeConnectionRegistry` are
 * intentionally separate interfaces with different callers: routes publish
 * observer events through the bus, `/v1/ws` drives observer socket upgrades
 * through the connection registry, and `/v1/node/ws` drives node transport.
 */

import type { FleetRelaycastToBrokerMessage } from '@relaycast/types';
import type { ObserverToken } from './auth.js';

/** A client-facing event payload, already passed through `transformForClient`. */
export type EngineEvent = Record<string, unknown>;

export interface RealtimeBus {
  /**
   * Publish to the workspace-level stream consumed by workspace-key (`rk_live_`)
   * subscribers. Replaces `publishToWorkspaceStream` + WorkspaceStreamDO `/deliver`.
   */
  publishToWorkspaceStream(args: {
    workspaceId: string;
    event: EngineEvent;
  }): Promise<void>;

}

export interface UpgradeArgs {
  request: Request;
  workspaceId: string;
  origin: { client: string; version: string };
  /** Cloud-only origin-actor path (`{app}/{type}[/{name}]`); defaults to `'unknown'`. */
  originActor?: string;
  /** Scoped observer principal for workspace stream sockets. */
  observerToken?: ObserverToken;
}

export interface ConnectionRegistry {
  /**
   * Upgrade an incoming request to a workspace observer stream. Returns the
   * `Response` (status 101 + the socket). Agent runtime traffic uses
   * {@link NodeConnectionRegistry} over `/v1/node/ws`.
   */
  upgrade(args: UpgradeArgs): Promise<Response>;
}

export interface NodeUpgradeArgs {
  request: Request;
  workspaceId: string;
  nodeId: string;
  nodeName: string;
  origin: { client: string; version: string };
  originActor?: string;
}

export interface NodeConnectionRegistry {
  /**
   * Upgrade an incoming node-control request. Cloudflare adapters own the 101
   * response; the Node adapter handles upgrades in the HTTP server and exposes
   * attachNodeSocket instead.
   */
  upgradeNode(args: NodeUpgradeArgs): Promise<Response>;

  /**
   * Push a typed node protocol message to a node's default provider (or its sole
   * connected provider). Provider-addressed callers use {@link sendToProvider}.
   */
  sendToNode(
    workspaceId: string,
    nodeId: string,
    message: FleetRelaycastToBrokerMessage,
  ): Promise<boolean>;

  /** Push a typed node protocol message to a specific provider's socket. */
  sendToProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    message: FleetRelaycastToBrokerMessage,
  ): Promise<boolean>;

  /** True when the node currently has at least one connected provider. */
  isNodeConnected(workspaceId: string, nodeId: string): boolean;

  /** True when a specific provider currently has a connected socket. */
  isProviderConnected(workspaceId: string, nodeId: string, providerName: string): boolean;

  /** The provider name bound to a registry connection, once it has registered. */
  providerNameForConnection?(connectionId: string): string | undefined;

  /**
   * Read-only pre-check for a provider registration: returns a conflict when the
   * name's current instance is a different, still-live connection (duplicate
   * process). A dropped/stale instance is replaced on {@link attachProvider}.
   */
  providerAttachConflict?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): { code: string; message: string } | null;

  /** Bind a provider name to a connection, superseding a stale prior attachment. */
  attachProvider?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): void;

  /** Drop a provider's attachment (provider-scoped deregister / prune). */
  detachProvider(workspaceId: string, nodeId: string, providerName: string): void;

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
