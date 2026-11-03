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
 * {@link EngineSocket}. Every entry point first reconciles the registry with
 * the control plane ({@link ActorRealtime.rehydrate}), so a lost memory never
 * leaves the registry and the sockets disagreeing.
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
import { SocketPrincipalSchema, socketGrantResponse, type SocketPrincipal } from './socket-grant.js';

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
  sockets: ActorSocketSource;
  /**
   * Receives every promise the registries start without awaiting (the drain
   * after a node attaches). The runtime settles them before its call returns,
   * when the sockets are still writable.
   */
  background: (promise: Promise<unknown>) => void;
}

/** A socket closed because the actor's memory (and so its registry) was lost while the socket stayed open. */
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

/** A close reason within the 123-byte limit, cut on a character boundary. */
export function toActorCloseReason(reason: string | undefined): string {
  let value = reason ?? '';
  const encoder = new TextEncoder();
  while (encoder.encode(value).byteLength > MAX_CLOSE_REASON_BYTES) value = value.slice(0, -1);
  return value;
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
  /** Connections the registry knows, by control-plane socket id. The only state kept across calls. */
  private readonly attached = new Map<string, Attached>();
  /** The live socket objects of the running call, by id; replaced by every {@link rehydrate}. */
  private live = new Map<string, ActorSocketLike>();

  constructor(private readonly db: EngineDb, private readonly options: ActorRealtimeOptions) {
    this.inner = new InProcessRealtime(db);
    this.inner.setBackgroundScheduler(options.background);
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
    return socketGrantResponse({
      v: 1,
      kind: 'observer',
      workspace_id: args.workspaceId,
      observer_token_id: args.observerToken.id,
    });
  }

  async upgradeNode(args: NodeUpgradeArgs): Promise<Response> {
    return socketGrantResponse({ v: 1, kind: 'node', workspace_id: args.workspaceId, node_id: args.nodeId });
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

  providerAttachConflict(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
  ): { code: string; message: string } | null {
    return this.inner.providerAttachConflict(workspaceId, nodeId, providerName, instanceId, connectionId);
  }

  attachProvider(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    instanceId: string,
    connectionId: string,
    callerAwareActions?: readonly string[],
  ): void {
    this.inner.attachProvider(workspaceId, nodeId, providerName, instanceId, connectionId, callerAwareActions);
  }

  setProviderDeliveryReadiness(
    workspaceId: string,
    nodeId: string,
    providerName: string,
    connectionId: string | undefined,
    mode: 'immediate' | 'agent_scoped',
  ): void {
    this.inner.setProviderDeliveryReadiness(workspaceId, nodeId, providerName, connectionId, mode);
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
  }

  isProviderAgentDeliveryReady(workspaceId: string, nodeId: string, providerName: string, agentId: string): boolean {
    return this.inner.isProviderAgentDeliveryReady(workspaceId, nodeId, providerName, agentId);
  }

  detachProvider(workspaceId: string, nodeId: string, providerName: string): void {
    this.inner.detachProvider(workspaceId, nodeId, providerName);
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
   * A connection the control plane holds but the registry does not know
   * means the actor's memory was lost (eviction, deploy, crash) while the
   * socket survived. Its provider binding, delivery readiness and queued
   * frames are gone, and nothing re-sends the `node.register` that built
   * them, so the socket is closed with {@link ACTOR_RESTARTED_CLOSE_CODE}
   * and the broker or observer reconnects and registers through the normal
   * path. The alternative, rebuilding registry state from the socket's
   * metadata, would attach an unbound connection whose readiness every
   * identity still had to re-announce; a reconnect is the same cost without
   * a second code path. The tradeoff: a restart costs every live socket one
   * reconnect.
   *
   * A connection the registry knows but the control plane no longer holds
   * (an `onDisconnect` the actor was not woken for) is closed on the registry
   * side, which runs the same teardown a disconnect does.
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

    for (const socket of connections) {
      if (this.attached.has(socket.id) || socket.id === event?.socket.id) continue;
      live.delete(socket.id);
      try {
        socket.close(ACTOR_RESTARTED_CLOSE_CODE, 'actor restarted');
      } catch {
        // already closed
      }
    }

    for (const [id, conn] of [...this.attached]) {
      // The disconnecting socket is torn down by onDisconnect itself.
      if (event?.phase === 'disconnect' && id === event.socket.id) continue;
      if (live.has(id)) continue;
      this.attached.delete(id);
      await conn.handle.handleClose();
    }
  }

  /**
   * A socket the gateway opened with a grant. Its metadata must be the
   * principal the grant carried, for this workspace, and still authenticate;
   * otherwise the connection is rejected.
   */
  async onConnect(socket: ActorSocketLike): Promise<void> {
    await this.rehydrate({ socket, phase: 'connect' });
    const parsed = SocketPrincipalSchema.safeParse(socket.metadata);
    if (!parsed.success) return reject(socket, INVALID_PRINCIPAL_CLOSE_CODE, 'invalid socket principal');
    const principal = parsed.data;
    if (principal.workspace_id !== this.options.workspaceId) {
      return reject(socket, INVALID_PRINCIPAL_CLOSE_CODE, 'socket principal names another workspace');
    }
    const workspace = await getWorkspaceExpiry(this.db, principal.workspace_id);
    if (!workspace || isWorkspaceExpired(workspace)) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'workspace unavailable');

    if (principal.kind === 'node') {
      const node = await getNodeById(this.db, principal.workspace_id, principal.node_id);
      if (!node) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'unknown node');
      socket.setTags(connectionTag(socket.id), 'kind:node', `node:${principal.node_id}`);
      const handle = this.inner.attachNodeSocket(principal.workspace_id, principal.node_id, this.engineSocket(socket.id));
      this.attached.set(socket.id, { principal, handle });
      return;
    }

    const token = await loadActiveObserverToken(this.db, principal.workspace_id, principal.observer_token_id);
    if (!token || !hasObserverScope(token, 'stream:read')) return reject(socket, UNAUTHORIZED_CLOSE_CODE, 'observer token unusable');
    socket.setTags(connectionTag(socket.id), 'kind:observer');
    const handle = this.inner.attachWorkspaceSocket(principal.workspace_id, this.engineSocket(socket.id), token);
    this.attached.set(socket.id, { principal, handle });
  }

  /** A JSON frame from the client; the registry reads it as the text the client sent. */
  async onMessage(socket: ActorSocketLike, message: unknown): Promise<void> {
    await this.rehydrate();
    const conn = this.attached.get(socket.id);
    // Not attached: rehydrate closed it (actor restarted) or it was rejected.
    if (!conn) return;
    await conn.handle.handleMessage(JSON.stringify(message));
  }

  async onDisconnect(socket: ActorSocketLike): Promise<void> {
    await this.rehydrate({ socket, phase: 'disconnect' });
    const conn = this.attached.get(socket.id);
    if (!conn) return;
    this.attached.delete(socket.id);
    // Teardown may write to other sockets, never to the one that closed.
    this.live.delete(socket.id);
    await conn.handle.handleClose();
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
        if (socket) socket.send(value);
        else this.options.sockets.broadcast(value, { tags: [connectionTag(socketId)] });
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
