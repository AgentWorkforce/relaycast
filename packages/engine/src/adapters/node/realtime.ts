import type {
  RealtimeBus,
  ConnectionRegistry,
  NodeConnectionRegistry,
  ActionProviderAuthorization,
  NodeDrainOptions,
  EngineEvent,
  UpgradeArgs,
  NodeUpgradeArgs,
} from '../../ports/realtime.js';
import type { ObserverToken } from '../../ports/auth.js';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { EngineDb } from '../../ports/database.js';
import {
  actions,
  actionInvocations,
  agentNodeBindings,
  agents,
  observerTokens,
} from '../../db/schema.js';
import { handleNodeControlMessage, handleProviderDisconnect, markNodeOffline } from '../../engine/node.js';
import { serializeNodeOp } from '../../engine/nodeLock.js';
import { DEFAULT_PROVIDER_NAME } from '../../engine/nodeProvider.js';
import { providerAttachDecision } from '../../engine/placement.js';
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
  /** Registry connection epoch, exposed for adapters that own provider binding. */
  connectionId?: string;
  handleMessage(raw: string): Promise<void>;
  handleClose(): Promise<void>;
}

/**
 * One node control connection. A provider binds its name at `node.register`;
 * `lastSeen` bounds how long a still-open-but-silent instance is treated as live
 * for duplicate-vs-reconnect arbitration.
 */
interface NodeConn {
  socket: EngineSocket;
  workspaceId: string;
  nodeId: string;
  providerName?: string;
  instanceId?: string;
  /** Null means legacy/immediate; a set means cursor-gated ready identities. */
  deliveryReadyAgentIds?: Set<string> | null;
  lastSeen: number;
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
  /** Every attached node control connection, keyed by its registry connection id. */
  private readonly nodeConnections = new Map<string, NodeConn>();
  /** All connection ids attached to a node (bound to a provider or not yet). */
  private readonly nodeConnIndex = new Map<string, Set<string>>();
  /** Per node, the connection id currently bound to each provider name. */
  private readonly providerIndex = new Map<string, Map<string, string>>();
  /** Per-provider queued `action.invoke` frames (`workspace:node::provider`). */
  private readonly nodeQueues = new Map<string, QueuedNodeMessage[]>();
  /** Serializes drains per node so concurrent triggers never overlap. */
  private readonly nodeDrainChains = new Map<string, Promise<void>>();
  private nodeCompletionDeps: InvocationCompletionDeps | undefined;
  private connectionSeq = 0;

  constructor(private readonly db: EngineDb) {}

  setNodeCompletionDeps(deps: InvocationCompletionDeps): void {
    this.nodeCompletionDeps = deps;
  }

  private nodeKey(workspaceId: string, nodeId: string): string {
    return `${workspaceId}:${nodeId}`;
  }

  private providerQueueKey(nodeKey: string, providerName: string): string {
    return `${nodeKey}::${providerName}`;
  }

  private providerConnId(nodeKey: string, providerName: string): string | undefined {
    return this.providerIndex.get(nodeKey)?.get(providerName);
  }

  private providerConnection(nodeKey: string, providerName: string): NodeConn | undefined {
    const connId = this.providerConnId(nodeKey, providerName);
    return connId ? this.nodeConnections.get(connId) : undefined;
  }

  private providerSocket(nodeKey: string, providerName: string): EngineSocket | undefined {
    const connId = this.providerConnId(nodeKey, providerName);
    if (connId) return this.nodeConnections.get(connId)?.socket;
    // Reconnect-before-reregister applies only to the synthetic `default`
    // provider (the legacy single-socket broker): its sole live connection is
    // addressable even before it re-registers, so queued frames drain to it. A
    // named provider's queue never drains to an unbound connection whose
    // identity isn't yet established — that could misroute to a different
    // provider that happens to be reconnecting.
    if (providerName !== DEFAULT_PROVIDER_NAME) return undefined;
    const conns = this.nodeConnIndex.get(nodeKey);
    if (conns && conns.size === 1) {
      const [only] = [...conns];
      const conn = this.nodeConnections.get(only);
      if (conn && !conn.providerName) return conn.socket;
    }
    return undefined;
  }

  /**
   * The provider a node-addressed message targets when none is specified: the
   * `default` provider if attached, otherwise any currently-attached provider.
   * Never returns a name that is not in the index, so node-level sends do not
   * silently target a phantom provider. `undefined` means nothing is attached.
   */
  private defaultProviderName(nodeKey: string): string | undefined {
    const providers = this.providerIndex.get(nodeKey);
    if (!providers || providers.size === 0) return undefined;
    if (providers.has(DEFAULT_PROVIDER_NAME)) return DEFAULT_PROVIDER_NAME;
    return [...providers.keys()][0];
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
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const providerName = this.defaultProviderName(nodeKey) ?? DEFAULT_PROVIDER_NAME;
    return this.sendToProvider(workspaceId, nodeId, providerName, message);
  }

  async sendToProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    message: FleetRelaycastToBrokerMessage,
  ): Promise<boolean> {
    return this.sendToProviderUnchecked(workspaceId, nodeId, providerName, message);
  }

  async sendAuthorizedActionToProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    message: Extract<FleetRelaycastToBrokerMessage, { type: 'action.invoke' }>,
    authorization: ActionProviderAuthorization,
  ): Promise<boolean> {
    if (authorization.kind === 'release-generation-v1') {
      const releaseInput = message.input;
      const inputMatches = !!releaseInput
        && typeof releaseInput === 'object'
        && !Array.isArray(releaseInput)
        && releaseInput.name === authorization.agentName
        && releaseInput.expected_token_hash === authorization.expectedTokenHash;
      if (
        message.invocation_id !== authorization.invocationId
        || message.action !== 'release'
        || !inputMatches
      ) {
        return false;
      }
      const [authorized] = await this.db
        .select({ id: actionInvocations.id })
        .from(actionInvocations)
        .innerJoin(agents, and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.name, authorization.agentName),
          eq(agents.tokenHash, authorization.expectedTokenHash),
          eq(agents.providerName, providerName),
        ))
        .innerJoin(agentNodeBindings, and(
          eq(agentNodeBindings.workspaceId, workspaceId),
          eq(agentNodeBindings.agentId, agents.id),
          eq(agentNodeBindings.nodeId, nodeId),
          eq(agentNodeBindings.status, 'active'),
        ))
        .where(and(
          eq(actionInvocations.workspaceId, workspaceId),
          eq(actionInvocations.id, authorization.invocationId),
          eq(actionInvocations.actionName, 'release'),
          eq(actionInvocations.invocationOrigin, 'builtin'),
          inArray(actionInvocations.status, ['pending', 'dispatched', 'invoked']),
          or(
            and(
              isNull(actionInvocations.dispatchedNodeId),
              eq(actionInvocations.handlerNodeId, nodeId),
            ),
            and(
              eq(actionInvocations.dispatchedNodeId, nodeId),
              eq(actionInvocations.dispatchedProvider, providerName),
            ),
          ),
          sql`json_extract(${actionInvocations.input}, '$.expected_token_hash') = ${authorization.expectedTokenHash}`,
        ));
      if (!authorized) {
        await this.db
          .update(actionInvocations)
          .set({
            status: 'failed',
            error: 'agent_release_generation_conflict',
            completedAt: new Date(),
          })
          .where(and(
            eq(actionInvocations.workspaceId, workspaceId),
            eq(actionInvocations.id, authorization.invocationId),
            inArray(actionInvocations.status, ['pending', 'dispatched', 'invoked']),
          ));
        return false;
      }

      // The authorization query resumes in the same in-process socket owner
      // that performs this synchronous send. With no await in between, a token
      // rotation cannot interleave after acceptance but before the frame is
      // handed to the provider. Remote owners implement this proof inside
      // their own serialized send boundary.
      return this.sendToProviderUnchecked(workspaceId, nodeId, providerName, message);
    }

    if (authorization.kind === 'registered-node-action-v1') {
      if (
        message.invocation_id !== authorization.invocationId
        || message.action !== authorization.actionName
      ) {
        return false;
      }
      const [accepted] = await this.db
        .update(actionInvocations)
        // Commit an immutable acceptance marker before the synchronous handoff
        // below so a stale dispatcher cannot mistake a later FK-null prune for
        // work that never reached the provider. Keep the public lifecycle state
        // `dispatched` until the provider reports progress or completion.
        .set({ providerAcceptedAttempt: actionInvocations.dispatchAttempts })
        .where(and(
          eq(actionInvocations.workspaceId, workspaceId),
          eq(actionInvocations.id, authorization.invocationId),
          eq(actionInvocations.invocationOrigin, 'registered_action'),
          eq(actionInvocations.actionId, authorization.actionId),
          eq(actionInvocations.actionName, authorization.invocationActionName),
          eq(actionInvocations.dispatchedNodeId, nodeId),
          eq(actionInvocations.dispatchedProvider, providerName),
          eq(actionInvocations.status, 'dispatched'),
          sql`EXISTS (
            SELECT 1 FROM ${actions}
            WHERE ${actions.workspaceId} = ${workspaceId}
              AND ${actions.id} = ${authorization.actionId}
              AND ${actions.name} = ${authorization.actionName}
              AND ${actions.handlerNodeId} = ${nodeId}
              AND COALESCE(${actions.handlerProvider}, ${DEFAULT_PROVIDER_NAME}) = ${providerName}
              AND ${actions.isActive} = 1
          )`,
        ))
        .returning({ id: actionInvocations.id });
      if (!accepted) return false;

      // No await occurs after the exact identity update resumes and before the
      // synchronous socket handoff. A prune/replacement must therefore win
      // before authorization or after this frame has already been accepted.
      return this.sendToProviderUnchecked(workspaceId, nodeId, providerName, message);
    }

    if (
      message.invocation_id !== authorization.invocationId
      || message.agent_id !== authorization.handlerAgentId
    ) {
      return false;
    }
    // The socket owner commits the exact action generation, delivery route,
    // and accepted attempt in one CAS before handing off the frame. Deleting
    // the action immediately after this point may clear action_id via the FK,
    // but cannot make cleanup fail or reroute work that the handler owns.
    const acceptedAttempt = authorization.recordAttempt
      ? sql`COALESCE(${actionInvocations.dispatchAttempts}, 0) + 1`
      : actionInvocations.dispatchAttempts;
    const [accepted] = await this.db
      .update(actionInvocations)
      .set({
        status: 'dispatched',
        handlerNodeId: sql`COALESCE(${actionInvocations.handlerNodeId}, ${nodeId})`,
        dispatchedNodeId: nodeId,
        dispatchedProvider: providerName,
        dispatchedAt: new Date(),
        retryAfterAt: null,
        providerAcceptedAttempt: acceptedAttempt,
        ...(authorization.recordAttempt ? {
          attemptedNodeIds: sql`json_insert(COALESCE(${actionInvocations.attemptedNodeIds}, '[]'), '$[#]', ${nodeId})`,
          dispatchAttempts: acceptedAttempt,
        } : {}),
      })
      .where(and(
        eq(actionInvocations.workspaceId, workspaceId),
        eq(actionInvocations.id, authorization.invocationId),
        eq(actionInvocations.invocationOrigin, 'registered_action'),
        eq(actionInvocations.actionId, authorization.actionId),
        eq(actionInvocations.actionName, message.action),
        inArray(actionInvocations.status, ['pending', 'dispatched', 'invoked']),
        eq(actionInvocations.handlerAgentId, authorization.handlerAgentId),
        eq(actionInvocations.handlerNodeId, nodeId),
        sql`EXISTS (
          SELECT 1 FROM ${actions}
          INNER JOIN ${agents}
            ON ${agents.workspaceId} = ${workspaceId}
           AND ${agents.id} = ${authorization.handlerAgentId}
           AND ${agents.status} = 'active'
           AND ${agents.locationType} = 'via_node'
           AND ${agents.locationNodeId} = ${nodeId}
           AND ${agents.providerName} = ${providerName}
          WHERE ${actions.workspaceId} = ${workspaceId}
            AND ${actions.id} = ${authorization.actionId}
            AND ${actions.name} = ${message.action}
            AND ${actions.handlerAgentId} = ${authorization.handlerAgentId}
            AND ${actions.handlerNodeId} IS NULL
            AND ${actions.isActive} = 1
        )`,
      ))
      .returning({ id: actionInvocations.id });
    if (!accepted) return false;

    // No await occurs between the acceptance CAS above resuming and
    // this in-process socket owner accepting the frame. Remote owners
    // implement the same serializable contract inside their own send boundary.
    // `action.invoke` is never rejected by the send itself here (an
    // unreachable provider queues it), so a recorded attempt always has a
    // frame behind it.
    return this.sendToProviderUnchecked(workspaceId, nodeId, providerName, message);
  }

  private async sendToProviderUnchecked(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    message: FleetRelaycastToBrokerMessage,
  ): Promise<boolean> {
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    if (
      message.type === 'deliver'
      && !this.isProviderAgentDeliveryReady(workspaceId, nodeId, providerName, message.agent_id)
    ) {
      return false;
    }
    const socket = this.providerSocket(nodeKey, providerName);
    if (socket) {
      let socketAccepted = false;
      try {
        socket.send(JSON.stringify(message));
        socketAccepted = true;
      } catch {
        this.detachProvider(workspaceId, nodeId, providerName);
        if (message.type !== 'action.invoke') return false;
      }
      if (socketAccepted) {
        return true;
      }
    }

    if (message.type !== 'action.invoke') {
      return false;
    }

    const queueKey = this.providerQueueKey(nodeKey, providerName);
    const queue = this.nodeQueues.get(queueKey) ?? [];
    const dedupKey = `${message.type}:${message.invocation_id}`;
    if (!queue.some((item) => item.key === dedupKey)) {
      queue.push({ key: dedupKey, message });
    }
    while (queue.length > 100) queue.shift();
    this.nodeQueues.set(queueKey, queue);
    return true;
  }

  isNodeConnected(workspaceId: string, nodeId: string): boolean {
    const conns = this.nodeConnIndex.get(this.nodeKey(workspaceId, nodeId));
    return !!conns && conns.size > 0;
  }

  isProviderConnected(workspaceId: string, nodeId: string, providerName: string): boolean {
    return !!this.providerSocket(this.nodeKey(workspaceId, nodeId), providerName);
  }

  isProviderAttached(workspaceId: string, nodeId: string, providerName: string): boolean {
    const connId = this.providerConnId(this.nodeKey(workspaceId, nodeId), providerName);
    return !!connId && this.nodeConnections.has(connId);
  }

  providerNameForConnection(connectionId: string): string | undefined {
    return this.nodeConnections.get(connectionId)?.providerName;
  }

  providerAttachConflict(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): { code: string; message: string } | null {
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const existingConnId = this.providerConnId(nodeKey, providerName);
    if (!existingConnId || existingConnId === connectionId) return null;
    const existing = this.nodeConnections.get(existingConnId);
    if (!existing) return null;
    // Spec §3.1 arbitration lives in the shared `providerAttachDecision` policy so
    // this in-process adapter and out-of-process socket owners (the
    // relaycast-cloud NodeDO) stay in lockstep: a same-instance re-register is a
    // reconnect, a different instance still framing within
    // PROVIDER_ATTACH_LIVENESS_MS is a live duplicate, and otherwise the incumbent
    // is stale and the restart supersedes it.
    const decision = providerAttachDecision({
      existingInstanceId: existing.instanceId,
      existingLastSeen: existing.lastSeen,
      incomingInstanceId: instanceId,
    });
    if (!decision.conflict) return null;
    return {
      code: decision.code,
      message: `Provider "${providerName}" is already connected on this node`,
    };
  }

  attachProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): void {
    const conn = this.nodeConnections.get(connectionId);
    if (!conn) return;
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    let providers = this.providerIndex.get(nodeKey);
    if (!providers) {
      providers = new Map();
      this.providerIndex.set(nodeKey, providers);
    }
    const existingConnId = providers.get(providerName);
    if (existingConnId && existingConnId !== connectionId) {
      const superseded = this.nodeConnections.get(existingConnId);
      this.nodeConnections.delete(existingConnId);
      const conns = this.nodeConnIndex.get(nodeKey);
      if (conns) {
        conns.delete(existingConnId);
        if (conns.size === 0) this.nodeConnIndex.delete(nodeKey);
      }
      if (superseded) {
        superseded.providerName = undefined;
        try {
          superseded.socket.close(1000, 'superseded');
        } catch {
          // already closed
        }
      }
    }
    // A re-register on the SAME live connection but with a NEW provider
    // identity (a different provider name, or a different instance id — a
    // restarted provider whose broker-side cursors are gone) must not inherit
    // the previous identity's ready-set. Reset it (back to undefined) so the
    // immediately-following `setProviderDeliveryReadiness('agent_scoped')`
    // starts a fresh empty Set and every identity must re-announce before
    // deliver frames flow — preservation applies only to a same-name,
    // same-instance reconnect.
    const previousProviderName = conn.providerName;
    const providerNameChanged = previousProviderName !== undefined && previousProviderName !== providerName;
    if (providerNameChanged || (conn.instanceId !== undefined && conn.instanceId !== instanceId)) {
      conn.deliveryReadyAgentIds = undefined;
    }
    // A rename would otherwise leave the old name's index entry pointing at
    // this socket forever (close cleanup only removes the current name).
    if (providerNameChanged && providers.get(previousProviderName) === connectionId) {
      providers.delete(previousProviderName);
    }
    conn.providerName = providerName;
    conn.instanceId = instanceId;
    conn.lastSeen = Date.now();
    providers.set(providerName, connectionId);
  }

  setProviderDeliveryReadiness(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    mode: 'immediate' | 'agent_scoped',
  ): void {
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const currentConnectionId = this.providerConnId(nodeKey, providerName);
    if (!currentConnectionId || (connectionId && currentConnectionId !== connectionId)) return;
    const conn = this.nodeConnections.get(currentConnectionId);
    if (!conn || conn.workspaceId !== workspaceId || conn.nodeId !== nodeId || conn.providerName !== providerName) return;
    if (mode === 'immediate') {
      conn.deliveryReadyAgentIds = null;
      return;
    }
    // agent_scoped: a re-register on the SAME live connection by the same
    // provider instance is a reconnect that does not invalidate broker-side
    // cursors, so keep the identities already marked ready — replacing the set
    // here would silently gate every in-flight delivery until each agent is
    // re-announced. A genuinely new connection starts with
    // `deliveryReadyAgentIds` undefined (a fresh NodeConn), so preservation
    // never carries across reconnects; a transition from immediate (null) still
    // resets to an empty set.
    if (!(conn.deliveryReadyAgentIds instanceof Set)) {
      conn.deliveryReadyAgentIds = new Set();
    }
  }

  markProviderAgentsDeliveryReady(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    agentIds: readonly string[],
  ): void {
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const currentConnectionId = this.providerConnId(nodeKey, providerName);
    if (!currentConnectionId || (connectionId && currentConnectionId !== connectionId)) return;
    const conn = this.nodeConnections.get(currentConnectionId);
    if (!(conn?.deliveryReadyAgentIds instanceof Set)) return;
    for (const agentId of agentIds) conn.deliveryReadyAgentIds.add(agentId);
  }

  isProviderAgentDeliveryReady(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    agentId: string,
  ): boolean {
    const conn = this.providerConnection(this.nodeKey(workspaceId, nodeId), providerName);
    if (!conn || conn.deliveryReadyAgentIds === undefined) return false;
    return conn.deliveryReadyAgentIds === null || conn.deliveryReadyAgentIds.has(agentId);
  }

  detachProvider(workspaceId: string, nodeId: string, providerName: string): void {
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const providers = this.providerIndex.get(nodeKey);
    const connId = providers?.get(providerName);
    if (providers) {
      providers.delete(providerName);
      if (providers.size === 0) this.providerIndex.delete(nodeKey);
    }
    if (connId) {
      const conn = this.nodeConnections.get(connId);
      if (conn) {
        conn.providerName = undefined;
        conn.deliveryReadyAgentIds = undefined;
      }
    }
    this.nodeQueues.delete(this.providerQueueKey(nodeKey, providerName));
  }

  async disconnectNode(workspaceId: string, nodeId: string): Promise<void> {
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const providers = this.providerIndex.get(nodeKey);
    const connIds = new Set<string>(providers ? providers.values() : []);
    // Also close any connections bound to this node that never registered.
    for (const [connId, conn] of this.nodeConnections) {
      if (conn.nodeId === nodeId && conn.workspaceId === workspaceId) connIds.add(connId);
    }
    for (const connId of connIds) {
      const conn = this.nodeConnections.get(connId);
      this.nodeConnections.delete(connId);
      if (conn) {
        try {
          conn.socket.close(1000, 'force-disconnect');
        } catch {
          // already closed
        }
      }
    }
    this.providerIndex.delete(nodeKey);
    this.nodeConnIndex.delete(nodeKey);
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
    const connectionId = `nconn_${++this.connectionSeq}`;
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    this.nodeConnections.set(connectionId, {
      socket,
      workspaceId,
      nodeId,
      lastSeen: Date.now(),
    });
    let conns = this.nodeConnIndex.get(nodeKey);
    if (!conns) {
      conns = new Set();
      this.nodeConnIndex.set(nodeKey, conns);
    }
    conns.add(connectionId);
    const handle: SocketHandle = {
      connectionId,
      handleMessage: async (raw) => {
        const conn = this.nodeConnections.get(connectionId);
        if (conn) conn.lastSeen = Date.now();
        return handleNodeControlMessage({
          db: this.db,
          registry: this,
          completionDeps: this.nodeCompletionDeps,
          workspaceId,
          nodeId,
          socket,
          connectionId,
          raw,
        });
      },
      handleClose: async () => this.onNodeConnectionClose(connectionId),
    };
    // Best-effort early flush (covers non-spawn frames that need no capacity);
    // the authoritative drain fires after node.register and after heartbeat
    // liveness/capacity transitions once the node is dispatchable. See drainNode.
    void this.drainNode(workspaceId, nodeId);
    return handle;
  }

  private async onNodeConnectionClose(connectionId: string): Promise<void> {
    const conn = this.nodeConnections.get(connectionId);
    if (!conn) return;
    this.nodeConnections.delete(connectionId);
    const { workspaceId, nodeId, providerName } = conn;
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    const conns = this.nodeConnIndex.get(nodeKey);
    if (conns) {
      conns.delete(connectionId);
      if (conns.size === 0) this.nodeConnIndex.delete(nodeKey);
    }
    const providers = this.providerIndex.get(nodeKey);
    if (providerName && providers?.get(providerName) === connectionId) {
      providers.delete(providerName);
      if (providers.size === 0) this.providerIndex.delete(nodeKey);
      this.nodeQueues.delete(this.providerQueueKey(nodeKey, providerName));
    }
    const hasRemaining = this.isNodeConnected(workspaceId, nodeId);
    // A teardown failure (e.g. SQLITE_BUSY) must be loud, not swallowed: if it
    // silently dropped the provider-offline / aggregate recompute the node roster
    // would keep stale capabilities with no signal. Log it; a close still must
    // not throw.
    if (providerName) {
      await handleProviderDisconnect(this.db, this, workspaceId, nodeId, providerName, hasRemaining, this.nodeCompletionDeps).catch((err) => {
        // Pass the error object so the runtime logs its stack, not just the message.
        console.error('[node.teardown] provider disconnect failed', { workspace_id: workspaceId, node_id: nodeId, provider: providerName }, err);
      });
    } else if (!hasRemaining) {
      // Connection dropped before it bound a provider and it was the node's last.
      // Serialize with node-control ops (register/heartbeat) and re-check
      // connectivity under the lock: a reconnect racing this close may have bound
      // a fresh socket, in which case the node must stay online. Without this a
      // stale close could append node.status.offline after the reconnect's online
      // event and leave the node marked offline despite a live socket.
      await serializeNodeOp(workspaceId, nodeId, async () => {
        if (this.isNodeConnected(workspaceId, nodeId)) return;
        await markNodeOffline(this.db, this, workspaceId, nodeId, { deps: this.nodeCompletionDeps, reason: 'disconnected' });
      }).catch((err) => {
        console.error('[node.teardown] mark node offline failed', { workspace_id: workspaceId, node_id: nodeId }, err);
      });
    }
  }

  /**
   * Public, serialized drain entrypoint. Concurrent calls for the same node are
   * chained so two drains never run at once (which could double-reserve spawn
   * capacity); each caller's promise resolves after its own drain pass runs.
   */
  drainNode(
    workspaceId: string,
    nodeId: string,
    options?: NodeDrainOptions,
  ): Promise<void> {
    const key = this.nodeKey(workspaceId, nodeId);
    const prior = this.nodeDrainChains.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.drainNodeQueue(workspaceId, nodeId, options));
    this.nodeDrainChains.set(key, next);
    void next.finally(() => {
      if (this.nodeDrainChains.get(key) === next) this.nodeDrainChains.delete(key);
    });
    return next;
  }

  private async drainNodeQueue(
    workspaceId: string,
    nodeId: string,
    options?: NodeDrainOptions,
  ): Promise<void> {
    if (!this.isNodeConnected(workspaceId, nodeId)) return;
    await drainNodeInvocations(this.db, this, workspaceId, nodeId, options);
    // The authoritative re-dispatch is DB-driven; clear the per-provider
    // in-memory buffers now that their frames have been re-sent.
    const nodeKey = this.nodeKey(workspaceId, nodeId);
    for (const queueKey of [...this.nodeQueues.keys()]) {
      if (queueKey.startsWith(`${nodeKey}::`)) this.nodeQueues.delete(queueKey);
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
}
