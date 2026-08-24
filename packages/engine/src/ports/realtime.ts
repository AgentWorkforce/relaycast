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

/**
 * Serializable proof inputs for an agent-hosted action dispatch. Remote socket
 * owners (for example a Cloudflare Durable Object) must re-read these durable
 * identities immediately before accepting the frame; a closure created in the
 * engine process cannot cross that transport boundary.
 */
export interface AgentActionProviderAuthorization {
  kind: 'agent-action-v1';
  invocationId: string;
  actionId: string;
  handlerAgentId: string;
  /** False when a queued attempt was already counted before this delivery. */
  recordAttempt: boolean;
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

  /**
   * Send an agent-hosted `action.invoke` only after the socket owner verifies
   * that the durable invocation is open and the action still names the same
   * handler. The owner also records provider acceptance before resolving.
   *
   * Optional for adapter source compatibility, but agent-hosted dispatch fails
   * closed when it is absent. This prevents an older remote adapter from
   * silently accepting a callback or option that it cannot enforce.
   */
  sendAuthorizedActionToProvider?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    message: Extract<FleetRelaycastToBrokerMessage, { type: 'action.invoke' }>,
    authorization: AgentActionProviderAuthorization,
  ): Promise<boolean>;

  /** True when the node currently has at least one connected provider. */
  isNodeConnected(workspaceId: string, nodeId: string): boolean;

  /** True when a specific provider currently has a connected socket. */
  isProviderConnected(workspaceId: string, nodeId: string, providerName: string): boolean;

  /**
   * True when the socket is explicitly bound to this provider. Unlike
   * isProviderConnected, this stays false for the synthetic default provider's
   * reconnect-before-reregister compatibility socket.
   */
  isProviderAttached?(workspaceId: string, nodeId: string, providerName: string): boolean;

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

  /**
   * Bind a provider name to a connection, superseding a stale prior attachment.
   * When the connection was already bound to a DIFFERENT provider identity —
   * another provider name, or another instance id (a same-socket re-register by
   * a restarted provider whose broker-side cursors are gone) — reset its
   * delivery ready-set so the following {@link setProviderDeliveryReadiness}
   * `agent_scoped` call starts empty and every identity must re-announce, and
   * drop the old name's index entry if it still points at this connection. Only
   * a same-name, same-instance re-register keeps the ready-set.
   */
  attachProvider?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): void;

  /**
   * Configure durable-delivery readiness for the active provider connection.
   * Cursor-negotiated connections start agent-scoped with no ready identities;
   * legacy connections are immediately ready for every hosted agent.
   *
   * `agent_scoped` must PRESERVE any identities already marked ready on the
   * resolved connection, but ONLY for a same-connection, same-name,
   * SAME-instance re-register: that is a reconnect and does not invalidate
   * broker-side cursors, so wiping the ready-set would silently gate every
   * in-flight delivery until each agent is re-announced. A re-register with a
   * NEW provider name or instance id is a different/restarted provider —
   * {@link attachProvider} clears the ready-set first, so this call starts a
   * fresh empty agent-scoped set. A genuinely new
   * connection has no ready-set yet, so it also starts empty; a transition from
   * `immediate` resets to an empty agent-scoped set. Out-of-process implementers
   * (relaycast-cloud NodeDO) must mirror this.
   */
  setProviderDeliveryReadiness?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    mode: 'immediate' | 'agent_scoped',
  ): void;

  /** Mark identities ready after their cursor-bearing reply is on the socket. */
  markProviderAgentsDeliveryReady?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    agentIds: readonly string[],
  ): void;

  /** Whether the current provider connection may receive durable frames for an identity. */
  isProviderAgentDeliveryReady?(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    agentId: string,
  ): boolean;

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

/** Registries without cursor-readiness support retain legacy immediate delivery. */
export function isProviderAgentDeliveryReady(
  registry: NodeConnectionRegistry,
  workspaceId: string,
  nodeId: string,
  providerName: string,
  agentId: string,
): boolean {
  return registry.isProviderAgentDeliveryReady?.(workspaceId, nodeId, providerName, agentId) ?? true;
}
