import { finalizeEvent, type Event } from 'nostr-tools';
import WebSocket from 'ws';

type PendingPublish = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class BuzzSocket {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingPublish>();
  private authEventId: string | null = null;
  private deliveryQueue: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(
    private readonly url: string,
    private readonly channelId: string,
    private readonly secretKey: Uint8Array,
    private readonly since: () => number,
    private readonly log: (message: string) => void = console.error,
  ) {}

  async run(signal: AbortSignal, onEvent: (event: Event) => Promise<unknown>, onReady: () => Promise<void>): Promise<void> {
    let delayMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.session(signal, onEvent, onReady);
        delayMs = 1_000;
      } catch (error) {
        if (!signal.aborted) this.log(`Buzz connection: ${String(error)}`);
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }

  publish(event: Event): Promise<void> {
    const existing = this.pending.get(event.id);
    if (existing) return existing.promise;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Buzz is disconnected.'));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      this.pending.delete(event.id);
      reject(new Error(`Buzz did not acknowledge ${event.id}.`));
    }, 15_000);
    this.pending.set(event.id, { promise, resolve, reject, timer });
    socket.send(JSON.stringify(['EVENT', event]), (error) => {
      if (error) this.settlePublish(event.id, error);
    });
    return promise;
  }

  close(): void {
    if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else this.socket?.close();
  }

  private async session(signal: AbortSignal, onEvent: (event: Event) => Promise<unknown>, onReady: () => Promise<void>): Promise<void> {
    const socket = new WebSocket(this.url, { maxPayload: 2 * 1024 * 1024 });
    this.socket = socket;
    this.authEventId = null;
    this.ready = false;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const opening = setTimeout(() => { socket.terminate(); reject(new Error('Buzz connection timed out.')); }, 15_000);
      const abort = () => {
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.on('open', () => {
        opened = true;
        clearTimeout(opening);
        this.subscribe();
      });
      socket.on('message', (bytes) => {
        try {
          const frame: unknown = JSON.parse(bytes.toString());
          this.handleFrame(frame, onEvent, onReady);
        } catch (error) {
          this.log(`Ignored invalid Buzz frame: ${String(error)}`);
        }
      });
      socket.on('error', (error) => {
        if (!opened) { clearTimeout(opening); reject(error); }
        else this.log(`Buzz socket: ${error.message}`);
      });
      socket.on('close', () => {
        clearTimeout(opening);
        signal.removeEventListener('abort', abort);
        if (this.socket === socket) this.socket = null;
        for (const [id] of this.pending) this.settlePublish(id, new Error('Buzz connection closed.'));
        if (!opened) reject(new Error('Buzz closed before opening.'));
        else resolve();
      });
    });
  }

  private handleFrame(frame: unknown, onEvent: (event: Event) => Promise<unknown>, onReady: () => Promise<void>): void {
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return;
    switch (frame[0]) {
      case 'AUTH': {
        if (typeof frame[1] !== 'string') return;
        const event = finalizeEvent({
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          content: '',
          tags: [['relay', this.url], ['challenge', frame[1]]],
        }, this.secretKey);
        this.authEventId = event.id;
        this.send(['AUTH', event]);
        break;
      }
      case 'OK': {
        if (typeof frame[1] !== 'string') return;
        const id = frame[1];
        const accepted = frame[2] === true;
        if (id === this.authEventId) {
          if (!accepted) { this.log(`Buzz rejected bot authentication: ${String(frame[3])}`); this.socket?.close(); }
          else this.subscribe();
          return;
        }
        this.settlePublish(id, accepted ? undefined : new Error(`Buzz rejected event: ${String(frame[3])}`));
        break;
      }
      case 'EVENT': {
        if (frame[1] !== 'relay-buzz-room' || !frame[2] || typeof frame[2] !== 'object') return;
        const event = frame[2] as Event;
        this.deliveryQueue = this.deliveryQueue.catch((error) => {
          this.log(`Buzz delivery queue recovered: ${String(error)}`);
        }).then(async () => {
          while (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try { await onEvent(event); return; }
            catch (error) {
              this.log(`Buzz event ${event.id} delivery failed, retrying: ${String(error)}`);
              await new Promise((resolve) => setTimeout(resolve, 5_000));
            }
          }
        }).catch((error) => {
          this.log(`Buzz event delivery failed unexpectedly: ${String(error)}`);
        });
        break;
      }
      case 'EOSE': {
        if (frame[1] !== 'relay-buzz-room' || this.ready) return;
        this.ready = true;
        void onReady().catch((error) => this.log(`Buzz reconciliation failed: ${String(error)}`));
        break;
      }
      case 'CLOSED': {
        if (frame[1] === 'relay-buzz-room' && !String(frame[2]).startsWith('auth-required:')) {
          this.log(`Buzz closed room subscription: ${String(frame[2])}`);
          this.socket?.close();
        }
        break;
      }
      case 'NOTICE': this.log(`Buzz notice: ${String(frame[1])}`); break;
    }
  }

  private subscribe(): void {
    this.send(['REQ', 'relay-buzz-room', { kinds: [9], '#h': [this.channelId], since: this.since() }]);
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private settlePublish(id: string, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (error) pending.reject(error);
    else pending.resolve();
  }
}
