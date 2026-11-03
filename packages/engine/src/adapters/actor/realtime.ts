/**
 * Realtime for a workspace actor: the in-process registries over the actor's
 * sockets.
 *
 * A durable actor's sockets live at the control plane and outlive the actor's
 * memory: the actor is woken for `onConnect` / `onMessage` / `onDisconnect`,
 * can list them (`getConnections`) and write to them (`socket.send`,
 * `broadcast`) only while one of its calls runs, and may be evicted between
 * calls, losing everything in memory while the sockets stay open.
 *
 * {@link ActorRealtime} composes {@link InProcessRealtime} (the registry
 * semantics: provider binding, delivery readiness, queued invokes, observer
 * filtering) and adapts each control-plane connection to an
 * {@link EngineSocket}. The registry state of every attached socket is also
 * written to the actor's `_actor_sockets` table as it changes, and every
 * entry point first reconciles the registry with the control plane
 * ({@link ActorRealtime.rehydrate}): a socket the control plane still holds
 * after the memory was lost is rebuilt from its row, so an actor's sleep
 * costs no reconnects.
 */
import type {
  ActionProviderAuthorization,
  ConnectionRegistry,
  EngineEvent,
  NodeConnectionRegistry,
  NodeDrainOptions,
  NodeUpgradeArgs,
  RealtimeBus,
  UpgradeArgs,
} from '../../ports/realtime.js';
import type { PresenceTracker } from '../../ports/presence.js';
import type { EngineDb } from '../../ports/database.js';
import type { InvocationCompletionDeps } from '../../engine/invocationCompletion.js';
import type { FleetRelaycastToBrokerMessage } from '@relaycast/types';
import { InProcessRealtime, loadActiveObserverToken, type EngineSocket, type SocketHandle } from '../node/realtime.js';
import { getNodeById } from '../../engine/node.js';
import { hasObserverScope } from '../../engine/observerToken.js';
import { getWorkspaceExpiry } from '../../engine/workspace.js';
import { isWorkspaceExpired } from '../../auth/workspaceExpiry.js';
import { SOCKET_GRANT_MAX_AGE_MS, SocketPrincipalSchema, signSocketPrincipal, socketGrantResponse, verifySocketPrincipal, type SocketPrincipal } from './socket-grant.js';
import { ActorSocketTable, type ActorSocketRow } from './socket-table.js';
import type { ActorSql } from './database.js';

/**
 * The actor-side socket, structurally (the engine does not depend on
 * durable-actors): `ActorSocket` as durable-actors 0.14 types it.
 */
export interface ActorSocketLike {
  readonly id: string;
  /** JSON the host attached when it granted the socket: a {@link SocketPrincipal}. */
  readonly metadata: unknown;
  readonly tags: readonly string[];
  /** Sends a JSON value; the client receives it as JSON text. */
  send(message: unknown): void;
  /** `code` is 1000 or 3000–4999; `reason` at most 123 UTF-8 bytes. */
  close(code?: number, reason?: string): void;
  /** Only during `onConnect`. */
  reject?(code?: number, reason?: string): void;
  /** At most 10 tags of 1–256 characters. */
  setTags(...tags: string[]): void;
}

export interface ActorBroadcastOptionsLike {
  readonly tags?: readonly string[];
  readonly tagMatch?: 'all' | 'any';
  readonly except?: Pick<ActorSocketLike, 'id'> | readonly Pick<ActorSocketLike, 'id'>[];
}

/** The actor's view of its sockets, usable only while an actor call runs. */
export interface ActorSocketSource {
  getConnections(tag?: string): Promise<readonly ActorSocketLike[]>;
  broadcast(message: unknown, options?: ActorBroadcastOptionsLike): void;
}

export interface ActorRealtimeOptions {
  /** The actor's workspace; sockets granted for another are refused. */
  workspaceId: string;
  /** Signs the socket grants this actor issues and verifies them at connect (the file-signing secret). */
  grantSecret: string;
  sockets: ActorSocketSource;
  /** The actor's database, for the `_actor_sockets` rows. */
  sql: ActorSql;
  /**
   * Receives every promise the registries start without awaiting (the drain
   * after a node attaches). The runtime settles them before its call returns,
   * when the sockets are still writable.
   */
  background: (promise: Promise<unknown>) => void;
}

/**
 * A socket the actor cannot account for: the control plane holds it but the
 * registry has no record of it, in memory or in `_actor_sockets` (a row
 * written before the table existed, or lost with a rolled-back call).
 */
export const ACTOR_RESTARTED_CLOSE_CODE = 4012;
/** The socket's metadata is not a {@link SocketPrincipal} for this workspace. */
export const INVALID_PRINCIPAL_CLOSE_CODE = 4400;
/** The principal no longer authenticates (observer token revoked, node gone, workspace expired). */
export const UNAUTHORIZED_CLOSE_CODE = 4401;

const MAX_CLOSE_REASON_BYTES = 123;

/**
 * An engine close code as durable-actors accepts it: 1000 and 3000–4999 pass
 * through; the standard 1001–1999 codes the engine uses (1008 policy
 * violation, 1012 service restart) move to 4000 + their last three digits,
 * so a client can still read which one it was.
 */
export function toActorCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1000) return 1000;
  if (Number.isInteger(code) && code >= 3000 && code <= 4999) return code;
  if (Number.isInteger(code) && code >= 1001 && code <= 1999) return 4000 + (code % 1000);
  return 4000;
}

/** A close reason within the 123-byte limit, cut on a code point boundary (never inside a surrogate pair). */
export function toActorCloseReason(reason: string | undefined): string {
  const encoder = new TextEncoder();
  const points = [...(reason ?? '')];
  while (encoder.encode(points.join('')).byteLength > MAX_CLOSE_REASON_BYTES) points.pop();
  return points.join('');
}

/** Tags the actor sets on a connection in `onConnect`, for `broadcast` targeting and inspection. */
export function connectionTag(socketId: string): string {
  return `c:${socketId}`;
}

interface Attached {
  readonly principal: SocketPrincipal;
  readonly handle: SocketHandle;
}

export class ActorRealtime implements RealtimeBus, ConnectionRegistry, NodeConnectionRegistry {
  private readonly inner: InProcessRealtime;
  /** The durable copy of the registry: one row per attached socket. */
  private readonly table: ActorSocketTable;
  /**
   * Connections the registry knows, by control-plane socket id. Kept in
   * memory for the activation and mirrored in {@link table}; a node
   * connection's registry id is its socket id, so bindings survive a rebuild.
   */
  private readonly attached = new Map<string, Attached>();
  /** The live socket objects of the running call, by id; replaced by every {@link rehydrate}. */
  private live = new Map<string, ActorSocketLike>();
  /**
   * Node connections a reconnect's `node.register` superseded, kept (in
   * memory, while the control plane still holds the socket) so a frame
   * already on its way still reaches the registry, which refuses all but
   * those settling work dispatched to it.
   */
  private readonly superseded = new Map<string, Attached>();
  /** Whether the rows written by an earlier activation were replayed into this one. */
  private replayed = false;
  /**
   * Nonces of the grants attached during this activation, by issue time,
   * so a captured grant cannot attach a second socket while it is still
   * valid. In memory only: a replay after the actor slept is bounded by the
   * grant's age instead.
   */
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly db: EngineDb, private readonly options: ActorRealtimeOptions) {
    this.inner = new InProcessRealtime(db);
    this.inner.setBackgroundScheduler(options.background);
    this.table = new ActorSocketTable(options.sql);
  }

  /* ----------------------------- composition ---------------------------- */

  setPresenceTracker(presence: PresenceTracker): void { this.inner.setPresenceTracker(presence); }
  setNodeCompletionDeps(deps: InvocationCompletionDeps): void { this.inner.setNodeCompletionDeps(deps); }

  publishToWorkspaceStream(args: { workspaceId: string; event: EngineEvent }): Promise<void> {
    return this.inner.publishToWorkspaceStream(args);
  }

  /**
   * The engine authenticated the observer token; answer with the grant the
   * gateway attaches to the socket. Only the token id travels: `onConnect`
   * re-reads the row and refuses a token revoked in between.
   */
  async upgrade(args: UpgradeArgs): Promise<Response> {
    if (!args.observerToken) return unauthorized('Observer token required for workspace stream');
    return socketGrantResponse(await signSocketPrincipal(this.options.grantSecret, {
      v: 1,
      kind: 'observer',
      workspace_id: args.workspaceId,
      observer_token_id: args.observerToken.id,
    }));
  }

  async upgradeNode(args: NodeUpgradeArgs): Promise<Response> {
    return socketGrantResponse(await signSocketPrincipal(this.options.grantSecret, { v: 1, kind: 'node', workspace_id: args.workspaceId, node_id: args.nodeId }));
  }

  sendToNode(workspaceId: string, nodeId: string, message: FleetRelaycastToBrokerMessage): Promise<boolean> {
    return this.inner.sendToNode(workspaceId, nodeId, message);
  }

  sendToProvider(workspaceId: string, nodeId: string, providerName: string, message: FleetRelaycastToBrokerMessage): Promise<boolean> {
    return this.inner.sendToProvider(workspaceId, nodeId, providerName, message);
  }

  sendAuthorizedActionToProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    message: Extract<FleetRelaycastToBrokerMessage, { type: 'action.invoke' }>,
    authorization: ActionProviderAuthorization,
  ): Promise<boolean> {
    return this.inner.sendAuthorizedActionToProvider(workspaceId, nodeId, providerName, message, authorization);
  }

  isNodeConnected(workspaceId: string, nodeId: string): boolean {
    return this.inner.isNodeConnected(workspaceId, nodeId);
  }

  isProviderConnected(workspaceId: string, nodeId: string, providerName: string): boolean {
    return this.inner.isProviderConnected(workspaceId, nodeId, providerName);
  }

  isProviderAttached(workspaceId: string, nodeId: string, providerName: string): boolean {
    return this.inner.isProviderAttached(workspaceId, nodeId, providerName);
  }

  providerNameForConnection(connectionId: string): string | undefined {
    return this.inner.providerNameForConnection(connectionId);
  }

  isConnectionSuperseded(connectionId: string): boolean {
    return this.inner.isConnectionSuperseded(connectionId);
  }

  providerAttachConflict(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): { code: string; message: string } | null {
    return this.inner.providerAttachConflict(workspaceId, nodeId, providerName, instanceId, connectionId);
  }

  /*
   * The engine binds providers and readiness through these (a node
   * connection's registry id is its socket id); `node.register` frames do
   * the same on the inner registry directly. After each, the connection's
   * state is copied to its row ({@link syncRow}).
   */

  attachProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
    callerAwareActions?: readonly string[],
  ): void {
    this.inner.attachProvider(workspaceId, nodeId, providerName, instanceId, connectionId, callerAwareActions);
    this.forgetDropped();
    this.syncRow(connectionId);
  }

  /**
   * Forget the node connections the registry dropped on its own: a
   * reconnect's `node.register` moves the provider binding to the new socket
   * and drops (and closes) the superseded one. Its row must go with it:
   * replayed into a later activation it would bind a socket that is gone,
   * and its teardown there would take the node offline under the live
   * socket. Its late `onDisconnect` then finds nothing to tear down, as the
   * registry intends.
   */
  private forgetDropped(): void {
    for (const [socketId, conn] of this.attached) {
      if (conn.principal.kind !== 'node' || this.inner.nodeConnectionState(socketId)) continue;
      this.attached.delete(socketId);
      this.table.delete(socketId);
      this.superseded.set(socketId, conn);
    }
  }

  setProviderDeliveryReadiness(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    mode: 'immediate' | 'agent_scoped',
  ): void {
    this.inner.setProviderDeliveryReadiness(workspaceId, nodeId, providerName, connectionId, mode);
    this.syncRow(connectionId ?? this.inner.providerConnectionId(workspaceId, nodeId, providerName));
  }

  providerDeliveryReadinessMode(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId?: string,
  ): 'immediate' | 'agent_scoped' | undefined {
    return this.inner.providerDeliveryReadinessMode(workspaceId, nodeId, providerName, connectionId);
  }

  markProviderAgentsDeliveryReady(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    agentIds: readonly string[],
  ): void {
    this.inner.markProviderAgentsDeliveryReady(workspaceId, nodeId, providerName, connectionId, agentIds);
    this.syncRow(connectionId ?? this.inner.providerConnectionId(workspaceId, nodeId, providerName));
  }

  isProviderAgentDeliveryReady(workspaceId: string, nodeId: string, providerName: string, agentId: string): boolean {
    return this.inner.isProviderAgentDeliveryReady(workspaceId, nodeId, providerName, agentId);
  }

  detachProvider(workspaceId: string, nodeId: string, providerName: string): void {
    const bound = this.inner.providerConnectionId(workspaceId, nodeId, providerName);
    this.inner.detachProvider(workspaceId, nodeId, providerName);
    this.syncRow(bound);
  }

  /** Copy a node connection's registry state to its row; nothing to copy for a connection the registry dropped. */
  private syncRow(socketId: string | undefined): void {
    if (!socketId || !this.attached.has(socketId)) return;
    const state = this.inner.nodeConnectionState(socketId);
    if (state) this.table.sync(socketId, state);
  }

  /** Closes go through each connection's {@link EngineSocket}, so they reach the actor sockets. */
  disconnectNode(workspaceId: string, nodeId: string): Promise<void> {
    return this.inner.disconnectNode(workspaceId, nodeId);
  }

  drainNode(workspaceId: string, nodeId: string, options?: NodeDrainOptions): Promise<void> {
    return this.inner.drainNode(workspaceId, nodeId, options);
  }

  /* --------------------------- socket lifecycle ------------------------- */

  /**
   * Reconcile the registry with the control plane, once at the start of
   * every actor call.
   *
   * On the first call of an activation the rows an earlier activation wrote
   * are replayed: a socket the control plane still holds is re-attached
   * under the same connection id with its provider binding, delivery
   * readiness, caller-aware actions and liveness timestamp (an observer with
   * its token re-read), so the sleep cost nothing. This is a memory rebuild,
   * not a reconnect: nothing is sent, no node goes online or offline. A row
   * whose socket the control plane no longer holds (an `onDisconnect` the
   * actor was not woken for) runs the same teardown a disconnect does, after
   * every surviving socket is back, so the teardown sees the node's live
   * connections and does not take it offline under them; one whose provider
   * a surviving socket already holds was superseded and is only forgotten.
   *
   * A connection the control plane holds that neither the memory nor the
   * table accounts for, or whose principal no longer validates, is closed
   * ({@link ACTOR_RESTARTED_CLOSE_CODE}, {@link UNAUTHORIZED_CLOSE_CODE}) and
   * the client reconnects through the normal path.
   *
   * `event` is the socket of the running lifecycle call, which the caller
   * handles itself: a connecting socket is attached after this, a
   * disconnecting one torn down after this.
   */
  async rehydrate(event?: { socket: ActorSocketLike; phase: 'connect' | 'disconnect' }): Promise<void> {
    const connections = await this.options.sockets.getConnections();
    const live = new Map<string, ActorSocketLike>();
    for (const socket of connections) live.set(socket.id, socket);
    if (event) live.set(event.socket.id, event.socket);
    this.live = live;

    if (!this.replayed) {
      this.replayed = true;
      const vanished: ActorSocketRow[] = [];
      for (const row of this.table.all()) {
        if (this.attached.has(row.socketId)) continue;
        if (event?.phase === 'connect' && row.socketId === event.socket.id) {
          // The id of a socket that is only now connecting: a stale row.
          this.table.delete(row.socketId);
          continue;
        }
        if (!live.has(row.socketId)) {
          vanished.push(row);
          continue;
        }
        await this.replayOrClose(row, live.get(row.socketId)!);
      }
      for (const row of vanished) {
        if (event?.phase === 'disconnect' && row.socketId === event.socket.id) continue;
        // Its provider is held by a socket that survived: this one was
        // superseded (a reconnect the actor did not stay awake for), and
        // rebuilding it would take the binding back from the live socket.
        if (row.kind === 'node' && row.nodeId && row.providerName
          && this.inner.providerConnectionId(row.workspaceId, row.nodeId, row.providerName) !== undefined) {
          this.table.delete(row.socketId);
          continue;
        }
        // Gone from the control plane: rebuild it only to run its teardown.
        const replayed = await this.replay(row, { earlyDrain: false });
        if (!replayed) {
          this.table.delete(row.socketId);
          continue;
        }
        await this.teardown(row.socketId);
      }
    }

    for (const socket of connections) {
      if (this.attached.has(socket.id) || socket.id === event?.socket.id) continue;
      const row = this.table.get(socket.id);
      if (row) {
        await this.replayOrClose(row, socket);
        continue;
      }
      live.delete(socket.id);
      try {
        socket.close(ACTOR_RESTARTED_CLOSE_CODE, 'actor restarted');
      } catch {
        // already closed
      }
    }

    for (const id of [...this.attached.keys()]) {
      // The disconnecting socket is torn down by onDisconnect itself.
      if (event?.phase === 'disconnect' && id === event.socket.id) continue;
      if (live.has(id)) continue;
      await this.teardown(id);
    }
    for (const id of [...this.superseded.keys()]) {
      if (!live.has(id)) this.superseded.delete(id);
    }
  }

  /** Re-attach a surviving socket from its row, or close it when its principal no longer validates. */
  private async replayOrClose(row: ActorSocketRow, socket: ActorSocketLike): Promise<void> {
    const replayed = await this.replay(row, { earlyDrain: true });
    if (replayed) return;
    this.table.delete(row.socketId);
    this.live.delete(row.socketId);
    try {
      const code = row.workspaceId === this.options.workspaceId ? UNAUTHORIZED_CLOSE_CODE : INVALID_PRINCIPAL_CLOSE_CODE;
      socket.close(code, 'socket principal no longer valid');
    } catch {
      // already closed
    }
  }

  /**
   * Rebuild one connection from its row: the same validation as
   * {@link onConnect}, then the registry calls `node.register` made, on the
   * inner registry directly so the row is not rewritten. False when the row
   * is not for this workspace or its principal no longer authenticates.
   */
  private async replay(row: ActorSocketRow, options: { earlyDrain: boolean }): Promise<boolean> {
    const workspaceId = this.options.workspaceId;
    if (row.workspaceId !== workspaceId) return false;
    const workspace = await getWorkspaceExpiry(this.db, workspaceId);
    if (!workspace || isWorkspaceExpired(workspace)) return false;

    if (row.kind === 'node') {
      if (!row.nodeId) return false;
      const node = await getNodeById(this.db, workspaceId, row.nodeId);
      if (!node) return false;
      const handle = this.inner.attachNodeSocket(workspaceId, row.nodeId, this.engineSocket(row.socketId), {
        connectionId: row.socketId,
        earlyDrain: options.earlyDrain,
      });
      this.inner.restoreNodeConnectionState(row.socketId, {
        providerName: row.providerName ?? undefined,
        instanceId: row.instanceId ?? undefined,
        deliveryReadyAgentIds: row.deliveryMode === null ? undefined : row.deliveryMode === 'immediate' ? null : row.deliveryReady ?? [],
        callerAwareActions: row.callerAwareActions,
        lastSeen: row.lastSeen,
      });
      this.attached.set(row.socketId, { principal: { v: 1, kind: 'node', workspace_id: workspaceId, node_id: row.nodeId }, handle });
      // Rows written before supersession dropped them may bind one provider twice.
      this.forgetDropped();
      return true;
    }

    if (!row.observerTokenId) return false;
    const token = await loadActiveObserverToken(this.db, workspaceId, row.observerTokenId);
    if (!token || !hasObserverScope(token, 'stream:read')) return false;
    const handle = this.inner.attachWorkspaceSocket(workspaceId, this.engineSocket(row.socketId), token);
    this.attached.set(row.socketId, {
      principal: { v: 1, kind: 'observer', workspace_id: workspaceId, observer_token_id: row.observerTokenId },
      handle,
    });
    return true;
  }

  /** Close a connection on the registry side (the teardown a disconnect runs) and drop its row. */
  private async teardown(socketId: string): Promise<void> {
    const conn = this.attached.get(socketId);
    this.attached.delete(socketId);
    this.superseded.delete(socketId);
    this.table.delete(socketId);
    if (conn) await conn.handle.handleClose();
  }

  /**
   * A socket the gateway opened with a grant. Its metadata must be the
   * principal this actor granted (signed by it, recent, not attached
   * before), for this workspace, and still authenticate; otherwise the
   * connection is rejected.
   */
  async onConnect(socket: ActorSocketLike): Promise<void> {
    await this.rehydrate({ socket, phase: 'connect' });
    // A reused socket id: the earlier connection is gone.
    if (this.attached.has(socket.id)) await this.teardown(socket.id);
    const parsed = SocketPrincipalSchema.safeParse(socket.metadata);
    if (!parsed.success) return reject(socket, INVALID_PRINCIPAL_CLOSE_CODE, 'invalid socket principal');
    const principal = parsed.data;
    if (principal.workspace_id !== this.options.workspaceId) {
      return reject(socket, INVALID_PRINCIPAL_CLOSE_CODE, 'socket principal names another workspace');
    }
    const now = Date.now();
    const verdict = await verifySocketPrincipal(this.options.grantSecret, principal, now);
    if (verdict !== 'ok') return reject(socket, UNAUTHORIZED_CLOSE_CODE, `socket grant ${verdict.replace(/_/g, ' ')}`);
    for (const [nonce, iat] of this.usedNonces) {
      if (now - iat > SOCKET_GRANT_MAX_AGE_MS) this.usedNonces.delete(nonce);
    }
    if (this.usedNonces.has(principal.nonce!)) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'socket grant already used');
    this.usedNonces.set(principal.nonce!, principal.iat!);
    const workspace = await getWorkspaceExpiry(this.db, principal.workspace_id);
    if (!workspace || isWorkspaceExpired(workspace)) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'workspace unavailable');

    if (principal.kind === 'node') {
      const node = await getNodeById(this.db, principal.workspace_id, principal.node_id);
      if (!node) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'unknown node');
      socket.setTags(connectionTag(socket.id), 'kind:node', `node:${principal.node_id}`);
      const handle = this.inner.attachNodeSocket(principal.workspace_id, principal.node_id, this.engineSocket(socket.id), {
        connectionId: socket.id,
      });
      this.attached.set(socket.id, { principal, handle });
      this.table.insert({ socketId: socket.id, kind: 'node', workspaceId: principal.workspace_id, nodeId: principal.node_id });
      return;
    }

    const token = await loadActiveObserverToken(this.db, principal.workspace_id, principal.observer_token_id);
    if (!token || !hasObserverScope(token, 'stream:read')) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'observer token unusable');
    socket.setTags(connectionTag(socket.id), 'kind:observer');
    const handle = this.inner.attachWorkspaceSocket(principal.workspace_id, this.engineSocket(socket.id), token);
    this.attached.set(socket.id, { principal, handle });
    this.table.insert({ socketId: socket.id, kind: 'observer', workspaceId: principal.workspace_id, observerTokenId: principal.observer_token_id });
  }

  /** A JSON frame from the client; the registry reads it as the text the client sent. */
  async onMessage(socket: ActorSocketLike, message: unknown): Promise<void> {
    await this.rehydrate();
    // A superseded socket's frame still reaches the registry, which refuses
    // all but the ones settling work dispatched to it.
    const conn = this.attached.get(socket.id) ?? this.superseded.get(socket.id);
    // Not attached: rehydrate closed it (nothing accounts for it) or it was rejected.
    if (!conn) return;
    await conn.handle.handleMessage(JSON.stringify(message));
    // The frame may have bound a provider (superseding another socket's
    // binding) or negotiated readiness, and refreshed the liveness timestamp
    // arbitration reads.
    if (conn.principal.kind === 'node') {
      this.forgetDropped();
      this.syncRow(socket.id);
    }
  }

  async onDisconnect(socket: ActorSocketLike): Promise<void> {
    await this.rehydrate({ socket, phase: 'disconnect' });
    // Teardown may write to other sockets, never to the one that closed.
    this.live.delete(socket.id);
    await this.teardown(socket.id);
  }

  /** The control-plane socket ids the registry currently knows. */
  attachedSocketIds(): string[] {
    return [...this.attached.keys()];
  }

  /**
   * The registry's socket for one connection. Writes go to the live socket
   * object of the running call when it is known, else to the connection's
   * tag, which the control plane routes without the object.
   */
  private engineSocket(socketId: string): EngineSocket {
    return {
      send: (data) => {
        const value: unknown = JSON.parse(data);
        const socket = this.live.get(socketId);
        try {
          if (socket) socket.send(value);
          else this.options.sockets.broadcast(value, { tags: [connectionTag(socketId)] });
        } catch (error) {
          // A superseded socket the control plane closed meanwhile cannot take
          // its last reply, and nothing depends on it. A failed write to a
          // current connection stays an error: the registry's recovery path
          // (detach, keep the frame queued) must see it.
          if (!this.superseded.has(socketId)) throw error;
        }
      },
      close: (code, reason) => {
        // A close needs the socket object; one the running call cannot see
        // is already gone from the control plane, and the next rehydrate
        // tears its registry entry down.
        this.live.get(socketId)?.close(toActorCloseCode(code), toActorCloseReason(reason));
      },
    };
  }
}

function reject(socket: ActorSocketLike, code: number, reason: string): void {
  if (socket.reject) socket.reject(code, reason);
  else socket.close(code, reason);
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
