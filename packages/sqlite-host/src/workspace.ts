/**
 * One workspace on this host: its SQLite file, the engine's actor runtime over
 * it, its sockets and alarm, and the durable log that makes every commit
 * survive the host.
 *
 * Calls run one at a time (the single writer). Each is one SQLite
 * transaction; when it commits, the frames it appended to the WAL go to the
 * log as the next slot, create-only, and the call is answered only after that
 * write is durable (`durability: 'sync'`, RPO 0). Socket writes made during a
 * call are held until then and dropped if the call fails, so a client never
 * sees state the store does not have. A lost slot (another host wrote it) or
 * a failed write means this copy may be ahead of or behind the log: the
 * workspace is evicted (file deleted, sockets closed so clients reconnect) and
 * the next call reloads it from the store.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createActorRuntime,
  type ActorBroadcastOptionsLike,
  type ActorEngineConfig,
  type ActorHttpRequest,
  type ActorRuntime,
  type ActorSocketLike,
  type ActorSocketSource,
} from '@relaycast/engine/adapters/actor';
import { WorkspaceDatabase } from './sql.js';
import { WalCursor, applySegment } from './wal.js';
import { parseSeq, seqKey, type LogStore } from './store.js';

export interface WorkspaceConfig {
  publicUrl: string;
  fileSigningSecret: string;
  engine: ActorEngineConfig;
}

export interface HostLog {
  (event: Record<string, unknown>): void;
}

export interface WorkspaceOptions {
  workspaceId: string;
  store: LogStore;
  /** Key prefix in the store, without a trailing slash. */
  prefix: string;
  dataDir: string;
  config: WorkspaceConfig;
  /** Commits between base snapshots. */
  baseEvery: number;
  /** `sync`: answer after the slot is durable. `async`: answer after the local commit, ship in order behind it. */
  durability: 'sync' | 'async';
  log: HostLog;
  /** The workspace dropped itself; the host forgets it. */
  onEvicted: (workspace: LoadedWorkspace) => void;
}

/** Another writer took a slot this host meant to write: this copy is stale. */
export class FencedError extends Error {
  constructor(readonly slot: number) {
    super(`log slot ${slot} was written by another host`);
    this.name = 'FencedError';
  }
}

/** A client socket as the actor runtime sees it; writes wait for the running call's commit. */
export interface ClientConnection {
  send(data: string): void;
  close(code: number, reason: string): void;
}

const SERVICE_RESTART = 4012;

class HostSocket implements ActorSocketLike {
  tags: readonly string[] = [];
  open = true;

  constructor(readonly id: string, readonly metadata: unknown, private readonly client: ClientConnection, private readonly owner: LoadedWorkspace) {}

  send(message: unknown): void {
    if (!this.open) throw new Error('cannot send on a closed socket');
    const data = JSON.stringify(message);
    this.owner.effect(() => this.client.send(data));
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    this.open = false;
    this.owner.forget(this.id);
    this.owner.effect(() => this.client.close(code, reason));
  }

  reject(code = 4008, reason = 'connection rejected'): void {
    this.close(code, reason);
  }

  setTags(...tags: string[]): void {
    this.tags = [...new Set(tags)];
  }

  /** Closes the client now, outside any call (eviction). */
  drop(code: number, reason: string): void {
    this.open = false;
    try {
      this.client.close(code, reason);
    } catch {
      // already gone
    }
  }
}

export class LoadedWorkspace {
  readonly id: string;
  private readonly db: WorkspaceDatabase;
  private readonly cursor: WalCursor;
  private readonly runtime: ActorRuntime;
  private readonly sockets = new Map<string, HostSocket>();
  private queue: Promise<unknown> = Promise.resolve();
  private effects: (() => void)[] | null = null;
  private alarmAt: number | null = null;
  private alarmTimer: NodeJS.Timeout | undefined;
  private shipping: Promise<void> = Promise.resolve();
  private commitsSinceBase = 0;
  evicted = false;

  private constructor(
    private readonly options: WorkspaceOptions,
    private readonly dbPath: string,
    private nextSeq: number,
  ) {
    this.id = options.workspaceId;
    this.db = new WorkspaceDatabase(dbPath);
    this.cursor = new WalCursor(`${dbPath}-wal`);
    const source: ActorSocketSource = {
      getConnections: async (tag) => [...this.sockets.values()].filter((socket) => tag === undefined || socket.tags.includes(tag)),
      broadcast: (message, options) => this.broadcast(message, options),
    };
    this.runtime = createActorRuntime({
      sql: this.db,
      workspaceId: this.id,
      baseUrl: options.config.publicUrl,
      fileSigningSecret: options.config.fileSigningSecret,
      outboundFetch: (input, init) => globalThis.fetch(input, init),
      alarm: { get: () => this.alarmAt, set: (at) => this.setAlarm(at) },
      sockets: source,
      config: options.config.engine,
      telemetry: {
        capture() {},
        captureException: (error, context) => console.error('relaycast', JSON.stringify(context ?? {}), error),
      },
    });
  }

  /** Rebuilds the workspace from the newest base snapshot and every log slot after it. */
  static async load(options: WorkspaceOptions): Promise<LoadedWorkspace> {
    const started = performance.now();
    const directory = join(options.dataDir, options.workspaceId);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    const dbPath = join(directory, 'workspace.db');
    const root = `${options.prefix}/${options.workspaceId}`;
    const [bases, slots] = await Promise.all([options.store.list(`${root}/base/`), options.store.list(`${root}/log/`)]);
    let seq = 0;
    const newestBase = bases.map(parseSeq).sort((a, b) => b - a)[0];
    if (newestBase !== undefined) {
      const body = await options.store.get(`${root}/base/${seqKey(newestBase)}`);
      if (!body) throw new Error(`base ${newestBase} vanished`);
      writeFileSync(dbPath, body);
      seq = newestBase;
    }
    const pending = slots.map(parseSeq).filter((slot) => slot > seq).sort((a, b) => a - b);
    const contiguous: number[] = [];
    for (const slot of pending) {
      if (slot !== seq + contiguous.length + 1) break;
      contiguous.push(slot);
    }
    const segments = await fetchAll(contiguous.map((slot) => `${root}/log/${seqKey(slot)}`), options.store, 32);
    for (const segment of segments) applySegment(dbPath, segment);
    seq += contiguous.length;
    const workspace = new LoadedWorkspace(options, dbPath, seq + 1);
    options.log({
      event: 'sqlite_workspace_loaded', workspace_id: options.workspaceId, base: newestBase ?? 0,
      slots_replayed: contiguous.length, next_slot: seq + 1, load_ms: round(performance.now() - started),
    });
    // The alarm lived in the old host's memory; run maintenance once so the
    // runtime re-arms it from the workspace's outstanding work.
    workspace.setAlarm(Date.now());
    return workspace;
  }

  invoke(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'create':
        return this.call(method, () => this.runtime.create(args[0] as ActorHttpRequest, args[1] as string));
      case 'importData':
        return this.call(method, () => this.runtime.importData(args[0], args[1] as string));
      case 'handle':
        return this.call(method, () => this.runtime.handle(args[0] as ActorHttpRequest));
      case 'fileStored':
        return this.call(method, () => this.runtime.fileStored(args[0] as string, args[1] as number));
      default:
        return Promise.reject(new Error(`unknown method ${method}`));
    }
  }

  async connect(metadata: unknown, client: ClientConnection): Promise<string> {
    const socket = new HostSocket(`s_${randomUUID()}`, metadata, client, this);
    this.sockets.set(socket.id, socket);
    try {
      await this.call('onConnect', () => this.runtime.onConnect(socket));
    } catch (error) {
      this.sockets.delete(socket.id);
      socket.drop(1011, 'connect failed');
      throw error;
    }
    return socket.id;
  }

  message(socketId: string, message: unknown): Promise<void> {
    const socket = this.sockets.get(socketId);
    if (!socket) return Promise.resolve();
    return this.call('onMessage', () => this.runtime.onMessage(socket, message)) as Promise<void>;
  }

  disconnect(socketId: string): Promise<void> {
    const socket = this.sockets.get(socketId);
    if (!socket) return Promise.resolve();
    this.sockets.delete(socketId);
    socket.open = false;
    return this.call('onDisconnect', () => this.runtime.onDisconnect(socket)) as Promise<void>;
  }

  /** Whether another host has written past this copy (checked between calls by the host's fence watch). */
  async superseded(): Promise<boolean> {
    if (this.evicted) return false;
    return (await this.options.store.get(this.slotKey(this.nextSeq))) !== null;
  }

  /** A socket write from the running call, applied once its commit is durable. */
  effect(apply: () => void): void {
    if (this.effects) this.effects.push(apply);
    else apply();
  }

  forget(socketId: string): void {
    this.sockets.delete(socketId);
  }

  evict(reason: string): void {
    if (this.evicted) return;
    this.evicted = true;
    clearTimeout(this.alarmTimer);
    for (const socket of this.sockets.values()) socket.drop(SERVICE_RESTART, 'workspace moved');
    this.sockets.clear();
    try {
      this.db.close();
    } catch {
      // already closed
    }
    rmSync(join(this.options.dataDir, this.id), { recursive: true, force: true });
    this.options.log({ event: 'sqlite_workspace_evicted', workspace_id: this.id, reason, next_slot: this.nextSeq });
    this.options.onEvicted(this);
  }

  private call<T>(method: string, work: () => Promise<T>): Promise<T> {
    const queuedAt = performance.now();
    const run = this.queue.then(() => this.execute(method, work, queuedAt));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execute<T>(method: string, work: () => Promise<T>, queuedAt: number): Promise<T> {
    if (this.evicted) throw new FencedError(this.nextSeq);
    const started = performance.now();
    this.effects = [];
    let result: T;
    try {
      result = await this.db.atomic(() => this.db.transaction(work));
    } catch (error) {
      this.effects = null;
      throw error;
    }
    const executed = performance.now();
    const segment = this.cursor.take();
    let putMs = 0;
    let slot: number | undefined;
    if (segment) {
      slot = this.nextSeq++;
      this.commitsSinceBase += 1;
      const ship = this.ship(slot, segment);
      if (this.options.durability === 'sync') {
        const putStarted = performance.now();
        await ship;
        putMs = performance.now() - putStarted;
      } else {
        // Async: the call is answered now; a failed write evicts the copy (RPO > 0).
        ship.catch(() => undefined);
      }
    }
    const effects = this.effects ?? [];
    this.effects = null;
    for (const apply of effects) apply();
    this.options.log({
      event: 'sqlite_host_call', workspace_id: this.id, method,
      queue_wait_ms: round(started - queuedAt), execution_ms: round(executed - started), put_ms: round(putMs),
      total_ms: round(performance.now() - queuedAt), slot: slot ?? null, bytes: segment?.length ?? 0,
    });
    if (this.commitsSinceBase >= this.options.baseEvery) await this.writeBase();
    return result!;
  }

  /** Writes `slot` behind every earlier one; any failure evicts this copy. */
  private ship(slot: number, segment: Buffer): Promise<void> {
    const shipped = this.shipping.then(async () => {
      if (this.evicted) throw new FencedError(slot);
      let created: boolean;
      try {
        created = await this.options.store.create(this.slotKey(slot), segment);
      } catch (error) {
        this.evict(`log write failed: ${(error as Error).message}`);
        throw error;
      }
      if (!created) {
        this.evict(`slot ${slot} taken`);
        throw new FencedError(slot);
      }
    });
    this.shipping = shipped.catch(() => undefined);
    return shipped;
  }

  private async writeBase(): Promise<void> {
    await this.shipping;
    if (this.evicted) return;
    const started = performance.now();
    this.db.checkpoint();
    this.cursor.reset();
    this.commitsSinceBase = 0;
    const body = readFileSync(this.dbPath);
    const asOf = this.nextSeq - 1;
    await this.options.store.put(`${this.options.prefix}/${this.id}/base/${seqKey(asOf)}`, body);
    this.options.log({ event: 'sqlite_base_written', workspace_id: this.id, slot: asOf, bytes: body.length, ms: round(performance.now() - started) });
  }

  private slotKey(slot: number): string {
    return `${this.options.prefix}/${this.id}/log/${seqKey(slot)}`;
  }

  private broadcast(message: unknown, options: ActorBroadcastOptionsLike = {}): void {
    const except = new Set((Array.isArray(options.except) ? options.except : options.except ? [options.except] : [])
      .map((socket: Pick<ActorSocketLike, 'id'>) => socket.id));
    const tags = options.tags ?? [];
    for (const socket of this.sockets.values()) {
      if (except.has(socket.id)) continue;
      const matches = options.tagMatch === 'any' ? tags.some((tag) => socket.tags.includes(tag)) : tags.every((tag) => socket.tags.includes(tag));
      if (matches) socket.send(message);
    }
  }

  private setAlarm(at: number): void {
    this.alarmAt = at;
    clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(() => {
      if (this.evicted || this.alarmAt !== at) return;
      void this.call('onAlarm', async () => {
        try {
          await this.runtime.maintain();
        } finally {
          if (this.alarmAt === at) this.alarmAt = null;
        }
      }).catch((error) => this.options.log({ event: 'sqlite_alarm_failed', workspace_id: this.id, error: String(error) }));
    }, Math.max(0, at - Date.now()));
    this.alarmTimer.unref();
  }
}

async function fetchAll(keys: string[], store: LogStore, concurrency: number): Promise<Buffer[]> {
  const out = new Array<Buffer>(keys.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (next < keys.length) {
      const index = next++;
      const body = await store.get(keys[index]);
      if (!body) throw new Error(`log slot ${keys[index]} vanished`);
      out[index] = body;
    }
  }));
  return out;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
