type AlarmOwner = {
  alarm?: () => Promise<void> | void;
};

export class FakeDurableObjectStorage {
  private readonly values = new Map<string, unknown>();
  private owner: AlarmOwner | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private transactionLock: Promise<unknown> = Promise.resolve();

  __setOwner(owner: AlarmOwner): void {
    this.owner = owner;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.values.delete(key);
    }
  }

  async transaction<T>(
    closure: (txn: {
      get<V = unknown>(key: string): Promise<V | undefined>;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
    }) => Promise<T>,
  ): Promise<T> {
    const run = this.transactionLock.then(() =>
      closure({
        get: async <V = unknown>(key: string) => this.values.get(key) as V | undefined,
        put: async (key: string, value: unknown) => {
          this.values.set(key, value);
        },
        delete: async (key: string) => this.values.delete(key),
      }),
    );
    this.transactionLock = run.catch(() => undefined);
    return run;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const entries = new Map<string, T>();
    for (const [key, value] of this.values.entries()) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        entries.set(key, value as T);
      }
    }
    return entries;
  }

  async setAlarm(when: number): Promise<void> {
    if (this.alarmTimer) {
      clearTimeout(this.alarmTimer);
      this.alarmTimer = null;
    }

    const delayMs = Math.max(0, when - Date.now());
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null;
      void this.owner?.alarm?.();
    }, delayMs);
  }

  async deleteAlarm(): Promise<void> {
    if (this.alarmTimer) {
      clearTimeout(this.alarmTimer);
      this.alarmTimer = null;
    }
  }
}

export class FakeWebSocket {
  private peer: FakeWebSocket | null = null;
  private owner: {
    webSocketMessage?: (ws: FakeWebSocket, message: string | ArrayBuffer) => Promise<void> | void;
    webSocketClose?: (ws: FakeWebSocket) => Promise<void> | void;
  } | null = null;
  private attachment: unknown = null;

  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  __link(peer: FakeWebSocket): void {
    this.peer = peer;
  }

  __accept(owner: {
    webSocketMessage?: (ws: FakeWebSocket, message: string | ArrayBuffer) => Promise<void> | void;
    webSocketClose?: (ws: FakeWebSocket) => Promise<void> | void;
  }): void {
    this.owner = owner;
  }

  send(payload: string | ArrayBuffer): void {
    const peer = this.peer;
    if (!peer) {
      throw new Error("websocket peer is not linked");
    }

    queueMicrotask(() => {
      if (peer.owner?.webSocketMessage) {
        void peer.owner.webSocketMessage(peer, payload);
        return;
      }

      peer.onmessage?.({ data: payload });
    });
  }

  close(code = 1000, reason = "closed"): void {
    const peer = this.peer;

    if (this.owner?.webSocketClose) {
      void this.owner.webSocketClose(this);
    } else {
      this.onclose?.({ code, reason });
    }

    if (!peer) {
      return;
    }

    if (peer.owner?.webSocketClose) {
      void peer.owner.webSocketClose(peer);
      return;
    }

    peer.onclose?.({ code, reason });
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

export class FakeDurableObjectState {
  readonly storage = new FakeDurableObjectStorage();
  private readonly sockets = new Set<FakeWebSocket>();
  private owner: AlarmOwner | null = null;

  __setOwner(owner: AlarmOwner): void {
    this.owner = owner;
    this.storage.__setOwner(owner);
  }

  acceptWebSocket(socket: FakeWebSocket): void {
    if (!this.owner) {
      throw new Error("durable object owner is not attached");
    }

    socket.__accept(this.owner as {
      webSocketMessage?: (ws: FakeWebSocket, message: string | ArrayBuffer) => Promise<void> | void;
      webSocketClose?: (ws: FakeWebSocket) => Promise<void> | void;
    });
    this.sockets.add(socket);
  }

  getWebSockets(): FakeWebSocket[] {
    return [...this.sockets];
  }

  setWebSocketAutoResponse(): void {}

  setHibernatableWebSocketEventTimeout(): void {}
}

export function createLinkedSockets(): {
  client: FakeWebSocket;
  server: FakeWebSocket;
} {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.__link(server);
  server.__link(client);
  return { client, server };
}
