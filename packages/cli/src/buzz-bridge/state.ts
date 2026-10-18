import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Event } from 'nostr-tools';

export interface RequestRecord {
  relayMessageId: string;
  conversationId: string;
  buzzEventId: string;
  rootEventId: string;
  senderPubkey: string;
  createdAt: number;
}

export interface ReplyRecord {
  event: Event;
  published: boolean;
}

export interface BridgeState {
  version: 1;
  binding: string | null;
  since: number;
  relayCursor: string | null;
  conversationId: string | null;
  requests: Record<string, RequestRecord>;
  replies: Record<string, ReplyRecord>;
}

export function emptyState(): BridgeState {
  return { version: 1, binding: null, since: Math.floor(Date.now() / 1000), relayCursor: null, conversationId: null, requests: {}, replies: {} };
}

export class StateStore {
  private state: BridgeState;
  private pendingWrite: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string, state: BridgeState) {
    this.state = state;
  }

  static async open(path: string): Promise<StateStore> {
    let state: BridgeState;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || (parsed as BridgeState).version !== 1) {
        throw new Error('Unknown Buzz bridge state version.');
      }
      state = parsed as BridgeState;
      if (!Number.isSafeInteger(state.since) || !state.requests || !state.replies || typeof state.requests !== 'object' || typeof state.replies !== 'object') {
        throw new Error('Invalid Buzz bridge state. Restore the state file before restarting.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = emptyState();
    }
    return new StateStore(path, state);
  }

  get data(): Readonly<BridgeState> { return this.state; }

  async bind(identity: string): Promise<void> {
    if (this.state.binding && this.state.binding !== identity) {
      throw new Error('This state file belongs to a different Buzz room or Relay agent. Use a separate state file.');
    }
    if (!this.state.binding) await this.update((state) => { state.binding = identity; });
  }

  async update(change: (state: BridgeState) => void): Promise<void> {
    const write = this.pendingWrite.then(() => this.writeUpdate(change));
    this.pendingWrite = write.catch(() => {});
    return write;
  }

  private async writeUpdate(change: (state: BridgeState) => void): Promise<void> {
    const next = structuredClone(this.state);
    change(next);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(next));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, this.path);
    this.state = next;
  }
}
