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
  AGENT_RELAY_DISTINCT_ID_QUERY,
  SDK_ORIGIN,
  sanitizeAgentRelayDistinctId,
  sanitizeOriginActor,
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
  autoAckDeliveries?: boolean;
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

export class WsClient {
  private token: string | (() => string | Promise<string>);
  private baseUrl: string;
  private path: string;
  private nodeRegistration?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  private autoAckDeliveries: boolean;
  private nodeMode: boolean;
  private lastNodeRegistration: Record<string, unknown> | null = null;
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
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private debug: boolean;
  private originClient: string;
  private originVersion: string;
  private originActor?: string;
  private agentRelayDistinctId?: string;
  /** Highest `agent_seq` observed across delivered events; null until the first stamped event. */
  private lastSeenSeq: number | null = null;
  /** Receive time of the last seq-stamped event, used as `since` for DB-backed replay. */
  private lastEventAt: string | null = null;
  /** Recently dispatched event ids (insertion-ordered for LRU eviction) for replay dedupe. */
  private seenEventIds = new Set<string>();

  constructor(options: WsClientOptions) {
    const origin = readInternalWsOrigin(options) ?? SDK_ORIGIN;
    this.token = options.token;
    this.path = options.path ?? '/v1/ws';
    this.nodeRegistration = options.nodeRegistration;
    this.autoAckDeliveries = options.autoAckDeliveries ?? false;
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
    this.agentRelayDistinctId = sanitizeAgentRelayDistinctId(
      origin.agentRelayDistinctId ?? options.agentRelayDistinctId,
    );
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
    if (this.agentRelayDistinctId) {
      wsUrl.searchParams.set(AGENT_RELAY_DISTINCT_ID_QUERY, this.agentRelayDistinctId);
    }

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

    if (this.nodeRegistration) {
      const registration = await this.nodeRegistration();
      if (this.ws !== ws || this.closed) return;
      this.lastNodeRegistration = registration;
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

  private emit(event: string, data: WsClientEvent): void {
    this.handlers.get(event)?.forEach((h) => h(data));
    this.handlers.get('*')?.forEach((h) => h(data));
  }

  private handleNodeMessage(parsed: unknown): boolean {
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return false;

    if (parsed.type === 'deliver') {
      const payload = isRecord(parsed.payload) ? parsed.payload : null;
      if (payload && typeof payload.type === 'string') {
        const data = isRecord(payload.data) ? payload.data : {};
        this.emitServerLikeEvent(payload.type, data);
      }
      if (
        this.autoAckDeliveries &&
        typeof parsed.agent === 'string' &&
        typeof parsed.seq === 'number' &&
        Number.isFinite(parsed.seq)
      ) {
        this.sendJson({
          v: 1,
          type: 'delivery.ack',
          agent: parsed.agent,
          up_to_seq: parsed.seq,
        });
      }
      return true;
    }

    if (parsed.type === 'context.update') {
      const eventType = typeof parsed.event === 'string' ? parsed.event : null;
      if (eventType) {
        this.emitServerLikeEvent(eventType, isRecord(parsed.data) ? parsed.data : {});
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
      });
      return true;
    }

    // Node control replies/errors are transport-level acknowledgements for the
    // direct node client. They are intentionally not surfaced as app events.
    return parsed.type === 'reply' || parsed.type === 'error' || parsed.type === 'pong' || parsed.type === 'resync_ack';
  }

  private emitServerLikeEvent(eventType: string, data: Record<string, unknown>): void {
    const transformed = this.transformServerLikeEvent(eventType, data);
    // Node delivery is at-least-once, so redelivered frames must be deduped
    // the same way the standard onmessage flow dedupes server events.
    if (
      typeof transformed.id === 'string' &&
      transformed.id.length > 0 &&
      typeof transformed.type === 'string'
    ) {
      const dedupeKey = `${transformed.type}:${transformed.id}`;
      if (this.seenEventIds.has(dedupeKey)) return;
      this.rememberEventId(dedupeKey);
    }
    const result = ServerEventSchema.safeParse(transformed);
    if (result.success) {
      this.emit(result.data.type, camelizeKeys(result.data) as WsClientEvent);
      return;
    }
    if (typeof transformed.type === 'string') {
      this.emit(transformed.type, camelizeKeys(transformed) as WsClientEvent);
    } else if (this.debug) {
      console.warn('[relaycast] Dropped node event: missing or invalid "type" field', transformed);
    }
  }

  private transformServerLikeEvent(eventType: string, data: Record<string, unknown>): Record<string, unknown> {
    switch (eventType) {
      case 'message.created':
        return {
          id: stableRelaycastEventId(String(data.id ?? '')),
          type: 'message.created',
          channel: data.channel_name,
          message: {
            id: data.id,
            agent_id: data.agent_id,
            agent_name: data.from_name,
            text: data.text,
            attachments: Array.isArray(data.attachments) ? data.attachments : [],
            ...(typeof data.injection_mode === 'string' ? { injection_mode: data.injection_mode } : {}),
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
    this.pingTimer = setInterval(() => {
      if (this.nodeMode) {
        const nodeId = typeof this.lastNodeRegistration?.node_id === 'string'
          ? this.lastNodeRegistration.node_id
          : undefined;
        this.sendJson({
          v: 1,
          type: 'node.heartbeat',
          ...(nodeId ? { node_id: nodeId } : {}),
          load: 0,
          active_agents: 1,
          handlers_live: false,
        });
        return;
      }
      this.sendJson({ type: 'ping' });
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
