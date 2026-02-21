import type { WsClientEvent, WsOpenEvent, WsErrorEvent, WsReconnectingEvent, WsCloseEvent } from './types.js';
import { ServerEventSchema } from '@relaycast/types';
import { SDK_ORIGIN, type InternalOrigin } from './origin.js';
import { camelizeKeys, decamelizeKey } from './casing.js';

export type EventHandler<T = WsClientEvent> = (event: T) => void;

export interface WsClientOptions {
  token: string;
  baseUrl?: string;
  /** Log warnings for dropped/malformed WebSocket messages via console.warn. */
  debug?: boolean;
}

const INTERNAL_WS_ORIGIN = Symbol('relaycast.internal.ws-origin');

type WsClientOptionsWithInternalOrigin = WsClientOptions & {
  [INTERNAL_WS_ORIGIN]?: InternalOrigin;
};

function readInternalWsOrigin(options: WsClientOptions): InternalOrigin | undefined {
  return (options as WsClientOptionsWithInternalOrigin)[INTERNAL_WS_ORIGIN];
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
  private token: string;
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private isOpen = false;
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutMs = 10_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private debug: boolean;
  private originSurface: string;
  private originClient: string;
  private originVersion: string;

  constructor(options: WsClientOptions) {
    const origin = readInternalWsOrigin(options) ?? SDK_ORIGIN;
    this.token = options.token;
    this.debug = options.debug ?? false;
    const base = (options.baseUrl ?? 'https://api.relaycast.dev').replace(/\/+$/, '');
    this.baseUrl = base.replace(/^http/, 'ws');
    this.originSurface = origin.surface;
    this.originClient = origin.client;
    this.originVersion = origin.version;
  }

  connect(): void {
    if (this.ws) return;
    this.closed = false;

    const wsUrl = new URL('/v1/ws', `${this.baseUrl}/`);
    wsUrl.searchParams.set('token', this.token);
    wsUrl.searchParams.set(decamelizeKey('originSurface'), this.originSurface);
    wsUrl.searchParams.set(decamelizeKey('originClient'), this.originClient);
    wsUrl.searchParams.set(decamelizeKey('originVersion'), this.originVersion);

    const ws = new WebSocket(wsUrl.toString());
    this.ws = ws;

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
      this.clearConnectTimer();
      this.isOpen = true;
      this.reconnectAttempt = 0;
      this.startPing();
      const openEvent: WsOpenEvent = { type: 'open' };
      this.emit('open', openEvent);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const parsed = JSON.parse(String(event.data));
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

  disconnect(): void {
    this.closed = true;
    this.isOpen = false;
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

  subscribe(channels: string[]): void {
    this.sendJson({ type: 'subscribe', channels });
  }

  unsubscribe(channels: string[]): void {
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

  private emit(event: string, data: WsClientEvent): void {
    this.handlers.get(event)?.forEach((h) => h(data));
    this.handlers.get('*')?.forEach((h) => h(data));
  }

  private sendJson(data: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt++;
    const reconnectingEvent: WsReconnectingEvent = { type: 'reconnecting', attempt: this.reconnectAttempt };
    this.emit('reconnecting', reconnectingEvent);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
