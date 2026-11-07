import type {
  WsClientEvent,
  WsOpenEvent,
  WsErrorEvent,
  WsReconnectingEvent,
  WsPermanentlyDisconnectedEvent,
  WsCloseEvent,
  WsResyncedEvent,
} from './types.js';
import { ServerEventSchema } from '@relaycast/types';
import {
  SDK_ORIGIN,
  applyAgentRelayIdentityQuery,
  resolveAgentRelayIdentity,
  sanitizeOriginActor,
  type AgentRelayIdentity,
  type InternalOrigin,
} from './origin.js';
import { camelizeKeys, decamelizeKey } from './casing.js';
import { stableRelaycastEventId } from './event-id.js';

export type EventHandler<T = WsClientEvent> = (event: T) => void;

export interface WsClientOptions {
  token: string | (() => string | Promise<string>);
  baseUrl?: string;
  path?: string;
  nodeRegistration?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Send `delivery.ack` (consumed) for each `deliver` frame. With the default
   * `ackMode: 'after-handlers'` the ack goes out only once every handler for
   * that delivery has returned and every returned promise has resolved; a
   * handler that throws or rejects leaves the delivery unacked, so the server
   * re-delivers it on reconnect. Each ack names its row (`delivery_id`) when
   * the engine's `node.register` reply listed the `delivery.ack.delivery_id`
   * capability, so it settles exactly what this client handled. An older
   * engine accepts only the cumulative `up_to_seq`, which this client sends
   * only while every lower seq it saw on this connection was consumed; a
   * success behind a failed delivery then stays unacked until the gap closes
   * or the connection resets, and is replayed, not re-handled.
   */
  autoAckDeliveries?: boolean;
  /**
   * `'after-handlers'` (default): ack after handlers complete, as above.
   * `'on-receipt'`: the pre-12.8 behaviour — ack synchronously right after
   * dispatch, whatever the handlers do. Only for clients that consume
   * deliveries without durable handlers and accept the re-delivery loss.
   */
  ackMode?: 'after-handlers' | 'on-receipt';  /**
   * Send `delivery.accepted` — "the receiving software holds this delivery
   * and will process it" (not a socket write, not the later consumption
   * ack); the receipt a sender's `wait_ms` waits for and the only thing that
   * makes its delivery `delivered` — after {@link acceptDelivery} has stored
   * the frame and before any handler runs. This client dispatches straight
   * to handlers with no queue, so the hook is the only durable holder; an
   * in-memory handler client reports `queued` -> `consumed`, never
   * `delivered`. Defaults to `false`: set it only when you persist
   * deliveries durably before handlers run, and supply `acceptDelivery`.
   * Without the hook nothing is sent, so an in-memory client reports
   * `queued` / `consumed` honestly rather than `delivered`. The frame itself
   * goes out only when the engine's `node.register` reply listed the
   * `delivery.accepted` capability, so an older engine never sees a frame it
   * would reject; the hook still runs against such an engine (the frame is
   * stored before any handler either way), it is just not reported.
   */
  autoAcceptDeliveries?: boolean;
  /**
   * Persistence hook for {@link autoAcceptDeliveries}: write the delivery to
   * your durable inbox or store. It runs for every `deliver` frame, whatever
   * the engine's capabilities; `delivery.accepted` is sent only after it
   * resolves (and only to an engine that listed the capability). If it
   * throws or rejects, nothing is stored, so the delivery is
   * neither accepted, dispatched nor acked: it stays unacked on the server and
   * is re-delivered on reconnect. Later frames on the connection still
   * process; acceptance then uses the per-delivery form until the gap is
   * re-delivered and persisted.
   */
  acceptDelivery?: (delivery: AcceptedDelivery) => Promise<void> | void;
  maxReconnectAttempts?: number;
  reconnectJitter?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  circuitBreakerMaxAttempts?: number;
  /** Log warnings for dropped/malformed WebSocket messages via console.warn. */
  debug?: boolean;
  /**
   * Optional User-Agent-style originActor identifier, forwarded as the `originActor`
   * query param (browsers can't set custom WS headers). See {@link sanitizeOriginActor}.
   */
  originActor?: string;
  /**
   * Optional Agent Relay distinct telemetry id, forwarded as the
   * `agent_relay_distinct_id` query param (browsers can't set custom WS
   * headers). Invalid values are dropped.
   */
  agentRelayDistinctId?: string;
  /**
   * Optional Agent Relay Cloud user id of the signed-in operator, forwarded as
   * the `agent_relay_user_id` query param. Doubles as the distinct id when
   * `agentRelayDistinctId` is unset.
   */
  agentRelayUserId?: string;
  /** Optional hashed machine id, forwarded as `agent_relay_machine_id`. */
  agentRelayMachineId?: string;
  /** Optional Agent Relay Cloud organization id, for group analytics. */
  agentRelayOrgId?: string;
  /** Optional organization slug, for readable analytics breakdowns. */
  agentRelayOrgSlug?: string;
}

/**
 * How many recently-seen event ids to remember for replay dedupe. Sized above
 * the server's 500-event resync ring plus DB-fallback replay batches.
 */
const SEEN_EVENT_IDS_MAX = 2048;

const INTERNAL_WS_ORIGIN = Symbol('relaycast.internal.ws-origin');

type WsClientOptionsWithInternalOrigin = WsClientOptions & {
  [INTERNAL_WS_ORIGIN]?: InternalOrigin;
};

function readInternalWsOrigin(options: WsClientOptions): InternalOrigin | undefined {
  return (options as WsClientOptionsWithInternalOrigin)[INTERNAL_WS_ORIGIN];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function withInternalWsOrigin<T extends WsClientOptions>(
  options: T,
  origin: InternalOrigin,
): T {
  const copy = { ...options } as WsClientOptionsWithInternalOrigin;
  Object.defineProperty(copy, INTERNAL_WS_ORIGIN, {
    value: origin,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return copy as T;
}

/** A `deliver` frame as handed to {@link WsClientOptions.acceptDelivery} before any handler runs. */
export interface AcceptedDelivery {
  deliveryId: string;
  agent: string;
  agentId: string | null;
  messageId: string | null;
  seq: number;
  mode: string | null;
  /** The event the frame carries (`{ type, data }`), as sent on the wire. */
  payload: Record<string, unknown> | null;
}

/**
 * A contiguous success watermark over a connection's `seq` stream, for the
 * cumulative `up_to_seq` form that older engines require. The first seq that
 * arrives anchors it just below; a success extends it only while every lower
 * seq since the anchor succeeded, so a cumulative `up_to_seq` is never
 * claimed across a failed (unpersisted / unconsumed) row. Out-of-order
 * successes are held and folded in once the gap closes. The anchor is not a
 * server cursor (this transport has no cursor handshake), so rows below the
 * first seq seen are outside what it can vouch for; that is why an engine
 * that accepts the per-delivery form is sent that form instead.
 */
class SeqWatermark {
  private high: number | null = null;
  private readonly held = new Set<number>();

  /** A seq arrived (whatever becomes of it): anchors the watermark on the first one. */
  arrive(seq: number): void {
    if (this.high === null) this.high = seq - 1;
  }

  /** Record a success; the new contiguous watermark when it moved, else `null` (a lower seq is still open). */
  record(seq: number): number | null {
    this.arrive(seq);
    if (seq <= this.high!) return null;
    this.held.add(seq);
    if (seq !== this.high! + 1) return null;
    while (this.held.has(this.high! + 1)) {
      this.high! += 1;
      this.held.delete(this.high!);
    }
    return this.high;
  }
}

/**
 * Steps run one after another in push order. An idle queue starts a step
 * synchronously (so handlers see a delivery at once); a step that fails is
 * reported and never stalls the next one.
 */
class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;

  push(step: () => Promise<void>, onError: (err: unknown) => void): void {
    const run = (): Promise<void> => {
      try {
        return step();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const next = this.pending === 0 ? run() : this.chain.then(run);
    this.pending += 1;
    this.chain = next.catch(onError).finally(() => {
      this.pending -= 1;
    });
  }
}

export class WsClient {
  private token: string | (() => string | Promise<string>);
  private baseUrl: string;
  private path: string;
  private nodeRegistration?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  private autoAckDeliveries: boolean;
  private autoAcceptDeliveries: boolean;
  private acceptDelivery?: (delivery: AcceptedDelivery) => Promise<void> | void;
  private ackMode: 'after-handlers' | 'on-receipt';
  /**
   * Intake of `deliver` frames (persist, `delivery.accepted`) in arrival
   * order; it never waits for handlers, so a slow handler holds neither later
   * acceptances nor other agents.
   */
  private deliverIntake = new SerialQueue();
  /**
   * Handler dispatch and `delivery.ack`, ordered per agent: an agent's
   * handlers see its deliveries in `seq` order, and a hung handler holds only
   * that agent's later handlers and acks (its rows stay unacked server-side).
   * Kept across reconnects: a replayed frame queues behind the earlier run of
   * the same agent and shares its outcome through `inFlightEvents`.
   * Best-effort `seq: 0` frames never enter it (see `dispatchBestEffort`).
   */
  private dispatchQueues = new Map<string, SerialQueue>();
  /**
   * Contiguous watermarks for `delivery.accepted` and `delivery.ack`, one per
   * agent (the engine numbers `seq` per agent row) and per connection.
   */
  private acceptWatermarks = new Map<string, SeqWatermark>();
  private ackWatermarks = new Map<string, SeqWatermark>();
  /**
   * Bumped on every socket open. A `deliver` frame is fenced to the generation
   * it arrived on: once the socket reconnected, the server replays everything
   * that connection left unacked, so a confirmation from the old generation
   * is dropped rather than applied to the new connection's watermarks.
   */
  private connectionGeneration = 0;
  private nodeMode: boolean;
  private lastNodeRegistration: Record<string, unknown> | null = null;
  /** The in-flight `node.register` request id, until its reply names the engine's capabilities. */
  private pendingRegistrationId: string | null = null;
  /** Inbound frame types the engine announced in its `node.register` reply (this connection). */
  private engineCapabilities = new Set<string>();
  private ws: WebSocket | null = null;
  private connecting = false;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private isOpen = false;
  private reconnectAttempt = 0;
  private maxReconnectAttempts: number;
  private reconnectJitter: boolean;
  private reconnectBaseDelayMs: number;
  private reconnectMaxDelayMs: number;
  private circuitBreakerMaxAttempts: number;
  private permanentlyDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutMs = 10_000;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatSequence = 0;
  private pendingPresence: { id: string; sentAt: number; agentId: string } | null = null;
  private confirmedPresenceAt: number | null = null;

  /** A server-confirmed direct-agent lease; socket openness alone grants nothing. */
  confirmedPresenceRemainingMs(): number {
    const age = this.confirmedPresenceAt === null ? Infinity : Date.now() - this.confirmedPresenceAt;
    return this.isOpen && age >= 0 && age < 30_000 ? 30_000 - age : 0;
  }
  private closed = false;
  private debug: boolean;
  private originClient: string;
  private originVersion: string;
  private originActor?: string;
  private identity: AgentRelayIdentity;
  /** Highest `agent_seq` observed across delivered events; null until the first stamped event. */
  private lastSeenSeq: number | null = null;
  /** Receive time of the last seq-stamped event, used as `since` for DB-backed replay. */
  private lastEventAt: string | null = null;
  /** Recently dispatched event ids (insertion-ordered for LRU eviction) for replay dedupe. */
  private seenEventIds = new Set<string>();
  /** Delivered events whose handlers are still running, by dedupe key. */
  private inFlightEvents = new Map<string, Promise<void>>();

  constructor(options: WsClientOptions) {
    const origin = readInternalWsOrigin(options) ?? SDK_ORIGIN;
    this.token = options.token;
    this.path = options.path ?? '/v1/ws';
    this.nodeRegistration = options.nodeRegistration;
    this.autoAckDeliveries = options.autoAckDeliveries ?? false;
    this.acceptDelivery = options.acceptDelivery;
    this.ackMode = options.ackMode ?? 'after-handlers';
    // Acceptance claims durable storage: only with a hook that provides it.
    this.autoAcceptDeliveries = options.autoAcceptDeliveries === true && typeof options.acceptDelivery === 'function';
    if (options.autoAcceptDeliveries === true && !this.autoAcceptDeliveries && options.debug) {
      console.warn('[relaycast] autoAcceptDeliveries needs an acceptDelivery persistence hook; no delivery.accepted will be sent');
    }
    this.nodeMode = this.path === '/v1/node/ws' || !!options.nodeRegistration;
    this.debug = options.debug ?? false;
    this.maxReconnectAttempts = Number.isFinite(options.maxReconnectAttempts)
      ? Math.max(0, Math.floor(options.maxReconnectAttempts!))
      : Number.POSITIVE_INFINITY;
    this.reconnectJitter = options.reconnectJitter ?? true;
    this.reconnectBaseDelayMs = Number.isFinite(options.reconnectBaseDelayMs)
      ? Math.max(1, Math.floor(options.reconnectBaseDelayMs!))
      : 1000;
    this.reconnectMaxDelayMs = Number.isFinite(options.reconnectMaxDelayMs)
      ? Math.max(this.reconnectBaseDelayMs, Math.floor(options.reconnectMaxDelayMs!))
      : 30_000;
    this.circuitBreakerMaxAttempts = Number.isFinite(options.circuitBreakerMaxAttempts)
      ? Math.max(1, Math.floor(options.circuitBreakerMaxAttempts!))
      : 30;
    const base = (options.baseUrl ?? 'https://cast.agentrelay.com').replace(/\/+$/, '');
    this.baseUrl = base.replace(/^http/, 'ws');
    this.originClient = origin.client;
    this.originVersion = origin.version;
    this.originActor = sanitizeOriginActor(origin.originActor ?? options.originActor);
    this.identity = resolveAgentRelayIdentity(origin, options);
  }

  connect(): void {
    if (this.ws || this.connecting) return;
    this.closed = false;
    this.permanentlyDisconnected = false;
    this.connecting = true;

    void this.openSocket().catch((err) => {
      this.connecting = false;
      if (this.closed) return;
      if (this.debug) {
        console.warn('[relaycast] Failed to open WebSocket:', err);
      }
      this.emit('error', { type: 'error' });
      this.scheduleReconnect();
    });
  }

  private async openSocket(): Promise<void> {
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    if (this.closed) {
      this.connecting = false;
      return;
    }

    const wsUrl = new URL(this.path, `${this.baseUrl}/`);
    wsUrl.searchParams.set('token', token);
    wsUrl.searchParams.set(decamelizeKey('originClient'), this.originClient);
    wsUrl.searchParams.set(decamelizeKey('originVersion'), this.originVersion);
    if (this.originActor) {
      wsUrl.searchParams.set('origin_actor', this.originActor);
    }
    applyAgentRelayIdentityQuery(wsUrl, this.identity);

    const ws = new WebSocket(wsUrl.toString());
    this.ws = ws;
    this.connecting = false;

    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || this.isOpen || this.closed) return;
      this.ws = null;
      this.emit('error', { type: 'error' });
      this.scheduleReconnect();
      try {
        ws.close();
      } catch {
        // noop
      }
    }, this.connectTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      void this.handleOpen(ws).catch((err) => {
        if (this.ws !== ws || this.closed) return;
        if (this.debug) {
          console.warn('[relaycast] WebSocket open handler failed:', err);
        }
        this.emit('error', { type: 'error' });
        try {
          ws.close();
        } catch {
          // noop
        }
      });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const parsed = JSON.parse(String(event.data));
        if (this.nodeMode && this.handleNodeMessage(parsed)) {
          return;
        }

        if (parsed !== null && typeof parsed === 'object') {
          // The server stamps every delivered event with a monotonic
          // `agent_seq` (stripped by schema parsing, so read it raw here).
          if (typeof parsed.agent_seq === 'number' && Number.isFinite(parsed.agent_seq)) {
            this.lastSeenSeq = parsed.agent_seq;
            this.lastEventAt = new Date().toISOString();
          }

          if (parsed.type === 'resync_ack') {
            const resyncedEvent: WsResyncedEvent = {
              type: 'resynced',
              replayed: typeof parsed.replayed === 'number' ? parsed.replayed : 0,
              gapDetected: parsed.gap_detected === true,
            };
            this.emit('resynced', resyncedEvent);
            return;
          }

          // Drop replays of events already dispatched (stable event id).
          if (typeof parsed.id === 'string' && parsed.id.length > 0 && typeof parsed.type === 'string') {
            const dedupeKey = `${parsed.type}:${parsed.id}`;
            if (this.seenEventIds.has(dedupeKey)) return;
            this.rememberEventId(dedupeKey);
          }
        }

        const result = ServerEventSchema.safeParse(parsed);
        if (result.success) {
          this.emit(result.data.type, camelizeKeys(result.data) as WsClientEvent);
        } else if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof parsed.type === 'string'
        ) {
          // Forward unrecognized event types so wildcard listeners still fire
          this.emit(parsed.type, camelizeKeys(parsed) as WsClientEvent);
        } else if (this.debug) {
          console.warn('[relaycast] Dropped WebSocket message: missing or invalid "type" field', parsed);
        }
      } catch (err) {
        if (this.debug) {
          console.warn('[relaycast] Dropped malformed WebSocket message:', String(event.data).slice(0, 200), err);
        }
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.isOpen = false;
      this.stopPing();
      this.ws = null;
      if (!this.closed) {
        this.scheduleReconnect();
      }
      const closeEvent: WsCloseEvent = { type: 'close' };
      this.emit('close', closeEvent);
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      const errorEvent: WsErrorEvent = { type: 'error' };
      this.emit('error', errorEvent);

      // Some runtimes report handshake failures via `error` without a
      // corresponding `close`. Ensure reconnect still progresses.
      if (!this.isOpen && !this.closed) {
        this.clearConnectTimer();
        this.ws = null;
        this.scheduleReconnect();
      }
    };
  }

  private async handleOpen(ws: WebSocket): Promise<void> {
    if (this.ws !== ws) return;
    this.clearConnectTimer();
    this.isOpen = true;
    this.reconnectAttempt = 0;
    this.permanentlyDisconnected = false;
    // A new connection replays from the server's cursor: watermarks restart,
    // and deliveries still in flight from the previous one may not confirm.
    this.connectionGeneration += 1;
    this.acceptWatermarks.clear();
    this.ackWatermarks.clear();

    if (this.nodeRegistration) {
      const registration = await this.nodeRegistration();
      if (this.ws !== ws || this.closed) return;
      this.lastNodeRegistration = registration;
      // A new connection may reach a different engine: forget what the last
      // one announced until this registration's reply says.
      this.engineCapabilities = new Set();
      this.pendingRegistrationId = typeof registration.id === 'string' ? registration.id : null;
      this.sendJson(registration);
    }

    this.startPing();
    const openEvent: WsOpenEvent = { type: 'open' };
    this.emit('open', openEvent);
    // After open handlers have re-subscribed, request replay of anything
    // missed while disconnected. A fresh client has no seq and sends nothing.
    this.sendResync();
  }

  disconnect(): void {
    this.closed = true;
    this.isOpen = false;
    this.connecting = false;
    this.permanentlyDisconnected = false;
    this.clearConnectTimer();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Null out handlers before closing to prevent the stale onclose
      // callback from clobbering a new connection (e.g. React strict mode).
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  reconnect(): void {
    this.closed = false;
    this.isOpen = false;
    this.connecting = false;
    this.permanentlyDisconnected = false;
    this.reconnectAttempt = 0;
    this.clearConnectTimer();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // noop
      }
      this.ws = null;
    }
    this.connect();
  }

  subscribe(channels: string[]): void {
    if (this.nodeMode) return;
    this.sendJson({ type: 'subscribe', channels });
  }

  unsubscribe(channels: string[]): void {
    if (this.nodeMode) return;
    this.sendJson({ type: 'unsubscribe', channels });
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // If the socket is already connected, immediately notify late open listeners.
    if (event === 'open' && this.isOpen) {
      queueMicrotask(() => {
        if (this.handlers.get('open')?.has(handler)) {
          handler({ type: 'open' } as WsOpenEvent);
        }
      });
    }

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  get connected(): boolean {
    return this.isOpen;
  }

  /**
   * Dispatch synchronously; nothing waits for the handlers. A promise a
   * handler returns is observed only to log its rejection (the workspace
   * stream has no ack for it to hold back), never left unhandled.
   */
  private emit(event: string, data: WsClientEvent): void {
    const run = (handler: EventHandler) => {
      const result = handler(data) as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        // `Promise.resolve` adopts any thenable (a query builder has no `catch`).
        Promise.resolve(result).catch((err) => this.warn('event handler failed', { event, error: err }));
      }
    };
    this.handlers.get(event)?.forEach(run);
    this.handlers.get('*')?.forEach(run);
  }

  /**
   * Dispatch synchronously like {@link emit}, and resolve once every handler
   * returned and every promise it returned settled; if any threw or
   * rejected it rejects, but only once the others have settled too, so a
   * failed delivery is not reported (and its agent's next delivery not
   * started, nor a re-delivered copy re-run) while a sibling handler is
   * still working on it. This is what a `delivery.ack` waits for.
   */
  private emitCollect(event: string, data: WsClientEvent): Promise<void> {
    const results: Promise<unknown>[] = [];
    const run = (handler: EventHandler) => {
      try {
        const result = handler(data) as unknown;
        if (result && typeof (result as Promise<unknown>).then === 'function') results.push(result as Promise<unknown>);
      } catch (err) {
        results.push(Promise.reject(err));
      }
    };
    this.handlers.get(event)?.forEach(run);
    this.handlers.get('*')?.forEach(run);
    return Promise.allSettled(results).then((settled) => {
      const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }

  private handleNodeMessage(parsed: unknown): boolean {
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return false;

    if (parsed.type === 'deliver') {
      if (parsed.seq === 0) {
        this.dispatchBestEffort(parsed);
        return true;
      }
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) && typeof parsed.agent === 'string') {
        this.watermarkFor(this.acceptWatermarks, parsed.agent).arrive(parsed.seq);
        this.watermarkFor(this.ackWatermarks, parsed.agent).arrive(parsed.seq);
      }
      this.queueDeliver(parsed);
      return true;
    }

    if (parsed.type === 'context.update') {
      const eventType = typeof parsed.event === 'string' ? parsed.event : null;
      if (eventType) {
        this.emitServerLikeEvent(eventType, isRecord(parsed.data) ? parsed.data : {})
          .catch((err) => this.warn('context handler failed', err));
      }
      return true;
    }

    if (parsed.type === 'action.invoke') {
      this.emitServerLikeEvent('action.invoked', {
        invocation_id: typeof parsed.invocation_id === 'string' ? parsed.invocation_id : '',
        action_name: typeof parsed.action === 'string' ? parsed.action : '',
        caller_name: 'node',
        handler_agent_id: typeof parsed.agent_id === 'string' ? parsed.agent_id : '',
        handler_agent_name: typeof parsed.agent_name === 'string' ? parsed.agent_name : undefined,
        input: isRecord(parsed.input) ? parsed.input : {},
      }).catch((err) => this.warn('action handler failed', err));
      return true;
    }

    if (this.pendingRegistrationId !== null && parsed.id === this.pendingRegistrationId) {
      this.pendingRegistrationId = null;
      const capabilities = parsed.type === 'reply' && parsed.ok === true && isRecord(parsed.data)
        ? parsed.data.capabilities
        : undefined;
      this.engineCapabilities = new Set(
        Array.isArray(capabilities) ? capabilities.filter((value): value is string => typeof value === 'string') : [],
      );
    }

    const pending = this.pendingPresence;
    if (pending && parsed.id === pending.id) {
      this.pendingPresence = null;
      const age = Date.now() - pending.sentAt;
      if (parsed.v === 1 && parsed.type === 'reply' && parsed.ok === true
        && isRecord(parsed.data) && parsed.data.agent_presence === true
        && parsed.data.agent_id === pending.agentId && age >= 0 && age < 30_000) {
        this.confirmedPresenceAt = pending.sentAt;
      }
    }

    // Node control replies/errors are transport-level acknowledgements for the
    // direct node client. They are intentionally not surfaced as app events.
    return parsed.type === 'reply' || parsed.type === 'error' || parsed.type === 'pong' || parsed.type === 'resync_ack';
  }

  private warn(message: string, detail: unknown): void {
    console.warn(`[relaycast] ${message}`, detail);
  }

  /**
   * Hand a best-effort `deliver` frame (`seq: 0`) to its handlers at once.
   * The engine sends ephemeral events (e.g. `action.completed`,
   * `agent.exited`) this way with a synthetic `delivery_id` and no durable
   * row: durable rows always carry `seq >= 1`. There is nothing to persist,
   * accept or ack, and nothing to order against, so the frame skips intake,
   * the persistence hook, both confirmations and the seq watermarks, and
   * bypasses the agent's dispatch queue: a message handler awaiting, say,
   * `on.actionCompleted` would otherwise wait on an event queued behind
   * itself. Dedupe and recipient scoping still apply; a handler failure is
   * logged, never retried (the engine does not re-deliver these).
   */
  private dispatchBestEffort(parsed: Record<string, unknown>): void {
    const agent = typeof parsed.agent === 'string' ? parsed.agent : null;
    const deliveryId = typeof parsed.delivery_id === 'string' ? parsed.delivery_id : null;
    let completed: Promise<void>;
    try {
      completed = this.dispatchDeliver(parsed, agent);
    } catch (err) {
      completed = Promise.reject(err);
    }
    completed.catch((err) => this.warn('best-effort delivery handler failed', { deliveryId, seq: 0, error: err }));
  }

  /**
   * Queue a durable `deliver` frame's intake behind the ones before it.
   * Best-effort frames (`seq: 0`) never reach here: they are dispatched at
   * once by {@link dispatchBestEffort}, outside intake and the agent's
   * dispatch queue.
   */
  private queueDeliver(parsed: Record<string, unknown>): void {
    // Fenced at arrival: a frame still queued when the socket reconnects
    // belongs to the old connection even though it runs after the reopen.
    const generation = this.connectionGeneration;
    const seq = typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : null;
    const deliveryId = typeof parsed.delivery_id === 'string' ? parsed.delivery_id : null;
    this.deliverIntake.push(
      () => this.processDeliver(parsed, generation),
      (err) => this.warn('delivery intake failed; delivery left on the server for re-delivery', { deliveryId, seq, error: err }),
    );
  }

  /**
   * Intake of one delivery: persist (when accepting) -> `delivery.accepted`
   * (only to an engine that listed it) -> hand it to its agent's dispatch
   * queue. The hook runs whatever the engine's capabilities: it is the
   * client's own durability, and skipping it against an older engine would
   * hand an unstored frame to the handlers. A failed hook leaves the row on
   * the server for re-delivery: neither accept, dispatch nor ack. Only
   * durable frames (`seq >= 1`) come through here; a best-effort `seq: 0`
   * frame bypasses intake and the dispatch queue entirely (see
   * {@link dispatchBestEffort}), so it can never wait behind a handler.
   */
  private async processDeliver(parsed: Record<string, unknown>, generation: number): Promise<void> {
    const seq = typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : null;
    const agent = typeof parsed.agent === 'string' ? parsed.agent : null;
    const deliveryId = typeof parsed.delivery_id === 'string' ? parsed.delivery_id : null;
    const hook = this.acceptDelivery;
    if (this.autoAcceptDeliveries && hook !== undefined && agent !== null && seq !== null && deliveryId !== null) {
      const delivery: AcceptedDelivery = {
        deliveryId,
        agent,
        agentId: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
        messageId: typeof parsed.msg_id === 'string' ? parsed.msg_id : null,
        seq,
        mode: typeof parsed.mode === 'string' ? parsed.mode : null,
        payload: isRecord(parsed.payload) ? parsed.payload : null,
      };
      try {
        await hook(delivery);
      } catch (err) {
        // Nothing is stored: neither accept, dispatch nor ack. The server
        // keeps the row and re-delivers it on reconnect.
        this.warn('acceptDelivery failed; delivery left on the server for re-delivery', { deliveryId, seq, error: err });
        return;
      }
      // Only the wire frame is gated on the capability: an older engine would
      // reject it (`invalid_message`), while the row above is stored either way.
      if (this.engineCapabilities.has('delivery.accepted')) {
        this.sendConfirmation('delivery.accepted', this.acceptWatermarks, generation, agent, deliveryId, seq);
      }
    }

    let queue = this.dispatchQueues.get(agent ?? '');
    if (queue === undefined) {
      queue = new SerialQueue();
      this.dispatchQueues.set(agent ?? '', queue);
    }
    queue.push(
      () => this.consumeDeliver(parsed, generation, agent, seq, deliveryId),
      (err) => this.warn('delivery processing failed; delivery left unconsumed for re-delivery', { deliveryId, seq, error: err }),
    );
  }

  /**
   * Handlers -> `delivery.ack` once they all completed. A handler failure
   * leaves the row unacked on the server for re-delivery.
   */
  private async consumeDeliver(
    parsed: Record<string, unknown>,
    generation: number,
    agent: string | null,
    seq: number | null,
    deliveryId: string | null,
  ): Promise<void> {
    const completed = this.dispatchDeliver(parsed, agent);
    if (!this.autoAckDeliveries || agent === null || seq === null) {
      completed.catch((err) => this.warn('delivery handler failed', { deliveryId, seq, error: err }));
      return;
    }
    if (this.ackMode === 'on-receipt') {
      // Legacy: consumed means dispatched, whatever the handlers do.
      if (generation === this.connectionGeneration) this.sendJson({ v: 1, type: 'delivery.ack', agent, up_to_seq: seq });
      completed.catch((err) => this.warn('delivery handler failed after on-receipt ack', { deliveryId, seq, error: err }));
      return;
    }
    try {
      await completed;
    } catch (err) {
      this.warn('delivery handler failed; delivery left unconsumed for re-delivery', { deliveryId, seq, error: err });
      return;
    }
    this.sendConfirmation('delivery.ack', this.ackWatermarks, generation, agent, deliveryId, seq);
  }

  /** Hand a `deliver` frame's event to handlers; resolves once they all completed. */
  private dispatchDeliver(parsed: Record<string, unknown>, recipient: string | null): Promise<void> {
    const payload = isRecord(parsed.payload) ? parsed.payload : null;
    if (!payload || typeof payload.type !== 'string') return Promise.resolve();
    const data = isRecord(payload.data) ? payload.data : {};
    return this.emitServerLikeEvent(payload.type, data, recipient);
  }

  private watermarkFor(watermarks: Map<string, SeqWatermark>, agent: string): SeqWatermark {
    let watermark = watermarks.get(agent);
    if (watermark === undefined) {
      watermark = new SeqWatermark();
      watermarks.set(agent, watermark);
    }
    return watermark;
  }

  /**
   * Report one success on the wire. Per delivery (`delivery_id`) whenever the
   * engine accepts that form (`delivery.accepted` is sent only to an engine
   * that listed it; `delivery.ack` by id needs `delivery.ack.delivery_id`):
   * it settles exactly the row this client handled. A cumulative `up_to_seq`
   * would also settle every lower unsettled row on the engine, and this
   * transport cannot vouch for rows below the first seq it saw on a
   * connection: a live frame can reach a fresh socket before the reconnect
   * replay of older unacked rows, which a cumulative ack would then bury
   * unhandled. An older engine accepts only the cumulative form, so for it
   * the success goes into the connection's contiguous watermark and is sent
   * as `up_to_seq` only while every lower seq seen here succeeded; otherwise
   * it is withheld and the row is replayed on the next connection and deduped
   * there. A success from a previous connection is dropped: that connection's
   * unacked rows are replayed on this one, and confirming a stale row here
   * (even by `delivery_id`) could race this connection's own dispatch of it.
   */
  private sendConfirmation(
    type: 'delivery.accepted' | 'delivery.ack',
    watermarks: Map<string, SeqWatermark>,
    generation: number,
    agent: string,
    deliveryId: string | null,
    seq: number,
  ): void {
    if (generation !== this.connectionGeneration) {
      this.warn(`${type} dropped: delivery belongs to a previous connection and is replayed on this one`, { deliveryId, seq });
      return;
    }
    const byId = type === 'delivery.accepted' || this.engineCapabilities.has('delivery.ack.delivery_id');
    if (byId && deliveryId !== null) {
      this.sendJson({ v: 1, type, agent, delivery_id: deliveryId });
      return;
    }
    const upTo = this.watermarkFor(watermarks, agent).record(seq);
    if (upTo !== null) {
      this.sendJson({ v: 1, type, agent, up_to_seq: upTo });
    } else {
      this.warn(`${type} withheld: the engine accepts only the cumulative form and a lower seq on this connection is unconsumed; the row stays unacked until the gap below it closes or it is replayed`, { deliveryId, seq });
    }
  }

  /**
   * Hand a delivered event to handlers; resolves once they all completed.
   * Node delivery is at-least-once, so redelivered frames are deduped the
   * same way the standard onmessage flow dedupes server events, but only a
   * frame whose handlers succeeded counts as seen: the key is recorded up
   * front (a duplicate arriving while the handlers run shares that run's
   * outcome instead of starting another) and forgotten again if they fail,
   * so the server's re-delivery of an unconsumed frame reruns them before
   * anything is acknowledged. The key is scoped to the `recipient` agent: one
   * message delivered to two agents hosted on this client is two deliveries,
   * each with its own handler run and ack.
   */
  private emitServerLikeEvent(eventType: string, data: Record<string, unknown>, recipient: string | null = null): Promise<void> {
    const transformed = this.transformServerLikeEvent(eventType, data);
    const dedupeKey =
      typeof transformed.id === 'string' && transformed.id.length > 0 && typeof transformed.type === 'string'
        ? `${recipient === null ? '' : `${recipient}:`}${transformed.type}:${transformed.id}`
        : null;
    if (dedupeKey === null) return this.emitTransformedEvent(transformed);
    const inFlight = this.inFlightEvents.get(dedupeKey);
    if (inFlight !== undefined) {
      // Settled by the run in progress; rerun only if that run failed (it
      // forgets the key first, so the rerun below records it afresh).
      return inFlight.then(undefined, () => this.emitServerLikeEvent(eventType, data, recipient));
    }
    if (this.seenEventIds.has(dedupeKey)) return Promise.resolve();
    this.rememberEventId(dedupeKey);
    let completed: Promise<void>;
    try {
      completed = this.emitTransformedEvent(transformed);
    } catch (err) {
      completed = Promise.reject(err);
    }
    const tracked = completed.then(
      () => {
        this.inFlightEvents.delete(dedupeKey);
      },
      (err: unknown) => {
        this.inFlightEvents.delete(dedupeKey);
        this.seenEventIds.delete(dedupeKey);
        throw err;
      },
    );
    this.inFlightEvents.set(dedupeKey, tracked);
    return tracked;
  }

  private emitTransformedEvent(transformed: Record<string, unknown>): Promise<void> {
    const result = ServerEventSchema.safeParse(transformed);
    if (result.success) {
      return this.emitCollect(result.data.type, camelizeKeys(result.data) as WsClientEvent);
    }
    if (typeof transformed.type === 'string') {
      return this.emitCollect(transformed.type, camelizeKeys(transformed) as WsClientEvent);
    }
    if (this.debug) {
      console.warn('[relaycast] Dropped node event: missing or invalid "type" field', transformed);
    }
    return Promise.resolve();
  }

  /** Normalize a direct-node delivery into the public workspace event shape. */
  private transformServerLikeEvent(eventType: string, data: Record<string, unknown>): Record<string, unknown> {
    switch (eventType) {
      case 'message.created':
        return {
          id: stableRelaycastEventId(String(data.id ?? '')),
          type: 'message.created',
          ...(typeof data.created_at === 'string' ? { created_at: data.created_at } : {}),
          channel: data.channel_name,
          message: {
            id: data.id,
            agent_id: data.agent_id,
            agent_name: data.from_name,
            text: data.text,
            attachments: Array.isArray(data.attachments) ? data.attachments : [],
            ...(typeof data.injection_mode === 'string' ? { injection_mode: data.injection_mode } : {}),
            ...(isRecord(data.metadata) ? { metadata: data.metadata } : {}),
          },
        };
      case 'thread.reply':
        return {
          id: stableRelaycastEventId(String(data.id ?? '')),
          type: 'thread.reply',
          channel: data.channel_name,
          parent_id: data.thread_id,
          message: {
            id: data.id,
            agent_id: data.agent_id,
            agent_name: data.from_name,
            text: data.text,
          },
        };
      case 'message.updated':
        return {
          type: 'message.updated',
          channel: data.channel_name,
          message: {
            id: data.id,
            agent_id: data.agent_id,
            agent_name: data.from_name,
            text: data.text,
          },
        };
      case 'message.reacted':
        return {
          type: 'message.reacted',
          message_id: data.message_id,
          emoji: data.emoji,
          agent_name: data.agent_name,
          action: data.action ?? 'added',
        };
      case 'dm.received':
      case 'group_dm.received': {
        const message = isRecord(data.message) ? data.message : {};
        const attachments = Array.isArray(message.attachments)
          ? message.attachments
          : Array.isArray(data.attachments)
            ? data.attachments
            : [];
        const messageId = String(message.id ?? data.id ?? '');
        return {
          id: stableRelaycastEventId(messageId),
          type: eventType,
          conversation_id: data.conversation_id,
          message: {
            id: message.id ?? data.id,
            agent_id: message.agent_id ?? data.from_agent_id ?? data.agent_id,
            agent_name: message.agent_name ?? data.from_name,
            text: message.text ?? data.text,
            ...((message.injection_mode ?? data.injection_mode) ? { injection_mode: message.injection_mode ?? data.injection_mode } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(typeof message.reply_to_message_id === 'string' ? { reply_to_message_id: message.reply_to_message_id } : {}),
          },
        };
      }
      default:
        return { type: eventType, ...data };
    }
  }

  private sendJson(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Request replay of events missed while disconnected. The server replays its
   * resync ring past `last_seen_seq`, falls back to a DB-backed replay from
   * `since` when the gap exceeds the ring, and answers with `resync_ack`.
   * No-op until at least one seq-stamped event has been received.
   */
  private sendResync(): void {
    if (this.nodeMode) return;
    if (this.lastSeenSeq === null) return;
    this.sendJson({
      type: 'resync',
      last_seen_seq: this.lastSeenSeq,
      ...(this.lastEventAt ? { since: this.lastEventAt } : {}),
    });
  }

  private rememberEventId(key: string): void {
    this.seenEventIds.add(key);
    if (this.seenEventIds.size > SEEN_EVENT_IDS_MAX) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }
  }

  private startPing(): void {
    this.stopPing();
    const schedule = (): void => {
      // Spread receipts without extending the established 30s maximum cadence.
      this.pingTimer = setTimeout(() => {
        if (!this.isOpen) return;
        if (this.nodeMode) {
          const nodeId = this.lastNodeRegistration?.node_id;
          const id = `sdk-presence-${++this.heartbeatSequence}`;
          this.pendingPresence = typeof nodeId === 'string' && nodeId.startsWith('node_direct_')
            ? { id, sentAt: Date.now(), agentId: nodeId.slice('node_direct_'.length) }
            : null;
          this.sendJson({
            v: 1, id, type: 'node.heartbeat',
            ...(typeof nodeId === 'string' ? { node_id: nodeId } : {}),
            load: null, active_agents: 1, handlers_live: false,
          });
        } else {
          this.sendJson({ type: 'ping' });
        }
        schedule();
      }, 27_000 + Math.floor(Math.random() * 3_000));
    };
    schedule();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
    this.pendingPresence = null;
    this.confirmedPresenceAt = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private computeReconnectDelayMs(attempt: number): number {
    const exponential = Math.min(
      this.reconnectBaseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
      this.reconnectMaxDelayMs,
    );
    if (!this.reconnectJitter) return exponential;
    const jitterFactor = 0.5 + Math.random();
    return Math.max(1, Math.round(exponential * jitterFactor));
  }

  private tripCircuitBreaker(): void {
    if (this.permanentlyDisconnected) return;
    this.permanentlyDisconnected = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const event: WsPermanentlyDisconnectedEvent = {
      type: 'permanently_disconnected',
      attempt: this.reconnectAttempt,
    };
    this.emit('permanently_disconnected', event);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed || this.permanentlyDisconnected) return;
    if (
      this.reconnectAttempt >= this.maxReconnectAttempts ||
      this.reconnectAttempt >= this.circuitBreakerMaxAttempts
    ) {
      this.tripCircuitBreaker();
      return;
    }
    this.reconnectAttempt += 1;
    const reconnectingEvent: WsReconnectingEvent = { type: 'reconnecting', attempt: this.reconnectAttempt };
    this.emit('reconnecting', reconnectingEvent);
    const delay = this.computeReconnectDelayMs(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
