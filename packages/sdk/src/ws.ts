import type { WsClientEvent, WsOpenEvent, WsErrorEvent, WsReconnectingEvent, WsCloseEvent } from '@relaycast/types';
import { ServerEventSchema } from '@relaycast/types';

export type EventHandler<T = WsClientEvent> = (event: T) => void;

export interface WsClientOptions {
  token: string;
  baseUrl?: string;
}

export class WsClient {
  private token: string;
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempt = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: WsClientOptions) {
    this.token = options.token;
    const base = options.baseUrl ?? 'https://api.agentrelay.dev';
    this.baseUrl = base.replace(/^http/, 'ws');
  }

  connect(): void {
    if (this.ws) return;
    this.closed = false;

    const url = `${this.baseUrl}/v1/stream?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.startPing();
      const openEvent: WsOpenEvent = { type: 'open' };
      this.emit('open', openEvent);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(String(event.data));
        const result = ServerEventSchema.safeParse(parsed);
        if (result.success) {
          this.emit(result.data.type, result.data);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (!this.closed) {
        this.scheduleReconnect();
      }
      const closeEvent: WsCloseEvent = { type: 'close' };
      this.emit('close', closeEvent);
    };

    this.ws.onerror = () => {
      const errorEvent: WsErrorEvent = { type: 'error' };
      this.emit('error', errorEvent);
    };
  }

  disconnect(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
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

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30_000);
    this.reconnectAttempt++;
    const reconnectingEvent: WsReconnectingEvent = { type: 'reconnecting', attempt: this.reconnectAttempt };
    this.emit('reconnecting', reconnectingEvent);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
