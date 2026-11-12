import Database from 'better-sqlite3';
import {
  createActorRuntime,
  type ActorBroadcastOptionsLike,
  type ActorRuntime,
  type ActorRuntimeOptions,
  type ActorSocketLike,
  type ActorSocketSource,
} from '../index.js';
import { SQLITE_CONSTRAINT_CODES, type ActorSql, type SqliteValue } from '../database.js';
import type { ActorHttpRequest, ActorHttpResponse } from '../http.js';
import { createCredentialTagSigner } from '../../../auth/credentialTags.js';
import { SocketPrincipalSchema, signSocketPrincipal } from '../socket-grant.js';

/** The file-signing secret the fake runtime signs grants with. */
export const FAKE_FILE_SECRET = 'file-secret-of-at-least-32-characters';

/** The keyring the fake gateway signs workspace tags with. */
export const TEST_CREDENTIAL_TAGS = createCredentialTagSigner({ current: 'a', keys: { a: 'actor-test-tag-secret' } });

const RUNTIME_OWNED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/i;
const ALLOWED_PRAGMA = /^\s*PRAGMA\s+(table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list|foreign_key_check|integrity_check|quick_check|user_version)\b/i;

/**
 * An in-memory stand-in for a durable actor's database with the runtime's
 * contract (durable-actors 0.14.5): one statement per `exec` (rows keyed by
 * column name, a repeated name keeps only its last value) or `query` (value
 * arrays plus column names), transaction statements and most PRAGMAs
 * rejected, constraint errors without `code`, each call one transaction, and
 * `transaction` nesting on savepoints.
 */
export class FakeActorDatabase implements ActorSql {
  readonly raw = new Database(':memory:');
  statements = 0;
  /** Every statement run through `exec` / `query`, in order. */
  readonly log: string[] = [];
  private savepoints = 0;

  constructor() {
    this.raw.pragma('foreign_keys = ON');
  }

  exec(sql: string, ...bindings: SqliteValue[]): object[] {
    return this.run(sql, (statement) => {
      // better-sqlite3 refuses all() on a statement without results; the
      // bun:sqlite facade (`npm run test:bun`) has no `reader` and allows it.
      if (statement.reader === false) {
        statement.run(...bindings);
        return [];
      }
      return statement.all(...bindings) as object[];
    });
  }

  query(sql: string, ...bindings: SqliteValue[]): { columns: string[]; rows: SqliteValue[][] } {
    return this.run(sql, (statement) => {
      if (statement.reader === false) {
        statement.run(...bindings);
        return { columns: [], rows: [] };
      }
      // better-sqlite3 names columns through columns(); the bun:sqlite facade through the native statement.
      const columns: string[] = typeof statement.columns === 'function'
        ? statement.columns().map((column) => column.name)
        : (statement as unknown as { stmt: { columnNames: string[] } }).stmt.columnNames;
      return { columns, rows: statement.raw(true).all(...bindings) as SqliteValue[][] };
    });
  }

  /** Nested transaction on a savepoint: if `operation` throws, only its writes roll back. */
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const name = `fake_actor_${++this.savepoints}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = await operation();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  private run<T>(sql: string, body: (statement: Database.Statement) => T): T {
    if (RUNTIME_OWNED.test(sql)) throw new Error(`The actor runtime owns transactions: ${sql.slice(0, 40)}`);
    if (/^\s*PRAGMA\b/i.test(sql) && !ALLOWED_PRAGMA.test(sql)) throw new Error('PRAGMA not allowed');
    this.statements += 1;
    this.log.push(sql);
    try {
      // better-sqlite3 refuses multi-statement strings in prepare(), like exec.
      return body(this.raw.prepare(sql));
    } catch (error) {
      // The runtime reports constraint failures as plain errors with the
      // extended result code in the message and no `code` property.
      const code = (error as { code?: string }).code;
      const number = Object.entries(SQLITE_CONSTRAINT_CODES).find(([, name]) => name === code)?.[0];
      if (number) throw new Error(`${(error as Error).message}: Error code ${number}: constraint failed`);
      throw error;
    }
  }

  /** An actor call: it commits, or rolls back when it throws. */
  async atomic<T>(call: () => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = await call();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

export class FakeAlarm {
  at: number | null = null;
  get(): number | null { return this.at; }
  set(timestampMs: number): void { this.at = timestampMs; }
}

function assertActorClose(code: number, reason: string): void {
  if (!Number.isInteger(code) || !(code === 1000 || (code >= 3000 && code <= 4999))) {
    throw new Error(`socket close code must be 1000 or between 3000 and 4999, got ${code}`);
  }
  if (Buffer.byteLength(reason) > 123) throw new Error('socket close reason must not exceed 123 bytes');
}

/**
 * A control-plane socket as durable-actors 0.14.6 presents it to the actor:
 * JSON in and out, `reject` only while connecting, close codes 1000 or
 * 3000–4999, at most 10 tags.
 */
export class FakeActorSocket implements ActorSocketLike {
  tags: readonly string[] = [];
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  /** Frames the client received. */
  readonly sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  rejected: { code: number; reason: string } | null = null;

  constructor(readonly id: string, readonly metadata: unknown, private readonly source: FakeSocketSource) {}

  send(message: unknown): void {
    this.source.touch('send');
    if (this.state === 'closed') throw new Error('cannot send on a closed actor socket');
    this.sent.push(message as Record<string, unknown>);
  }

  close(code = 1000, reason = ''): void {
    this.source.touch('close');
    assertActorClose(code, reason);
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.closed = { code, reason };
    this.source.connections.delete(this.id);
  }

  reject(code = 4008, reason = 'connection rejected'): void {
    this.source.touch('reject');
    if (this.state !== 'connecting') throw new Error('only a connecting actor socket can be rejected');
    assertActorClose(code, reason);
    this.state = 'closed';
    this.rejected = { code, reason };
    this.source.connections.delete(this.id);
  }

  setTags(...tags: string[]): void {
    this.source.touch('setTags');
    const unique = [...new Set(tags)];
    if (unique.length > 10 || unique.some((tag) => tag.length === 0 || tag.length > 256)) {
      throw new Error('socket tags must be at most 10 of 1-256 characters');
    }
    this.tags = unique;
  }

  /** Frames of a given `type`. */
  ofType(type: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

/**
 * The control plane's view of an actor's sockets. Like the runtime, it
 * answers `getConnections` / `broadcast` only while an actor call runs
 * (`during`); any socket use outside one is recorded in `violations`.
 */
export class FakeSocketSource implements ActorSocketSource {
  readonly connections = new Map<string, FakeActorSocket>();
  active = false;
  /** Socket operations attempted outside an actor call. */
  readonly violations: string[] = [];
  private seq = 0;

  touch(operation: string): void {
    if (!this.active) this.violations.push(operation);
  }

  async getConnections(tag?: string): Promise<readonly ActorSocketLike[]> {
    this.touch('getConnections');
    if (!this.active) throw new Error('actor connections are available only during an actor invocation');
    return [...this.connections.values()].filter((socket) => tag === undefined || socket.tags.includes(tag));
  }

  broadcast(message: unknown, options: ActorBroadcastOptionsLike = {}): void {
    this.touch('broadcast');
    if (!this.active) throw new Error('actor connections are available only during an actor invocation');
    const except = new Set((Array.isArray(options.except) ? options.except : options.except ? [options.except] : [])
      .map((socket: Pick<ActorSocketLike, 'id'>) => socket.id));
    const tags = options.tags ?? [];
    for (const socket of this.connections.values()) {
      if (except.has(socket.id)) continue;
      const matches = options.tagMatch === 'any'
        ? tags.some((tag) => socket.tags.includes(tag))
        : tags.every((tag) => socket.tags.includes(tag));
      if (matches) socket.send(message);
    }
  }

  /** A connection the gateway opened with `metadata`; the actor has not been told yet. */
  connecting(metadata: unknown): FakeActorSocket {
    const socket = new FakeActorSocket(`sock_${++this.seq}`, metadata, this);
    this.connections.set(socket.id, socket);
    return socket;
  }

  /** A connection the control plane holds open that the actor never saw (its memory was lost). */
  open(metadata: unknown): FakeActorSocket {
    const socket = this.connecting(metadata);
    socket.state = 'open';
    return socket;
  }

  /** The control plane lost a socket without waking the actor for `onDisconnect`. */
  drop(socket: FakeActorSocket): void {
    this.connections.delete(socket.id);
    socket.state = 'closed';
  }

  async during<T>(work: () => Promise<T>): Promise<T> {
    this.active = true;
    try {
      return await work();
    } finally {
      this.active = false;
    }
  }
}

/** What an activation of the fake actor shares with the next one: its database, alarm and control-plane sockets. */
export interface FakeActorState {
  sql: FakeActorDatabase;
  alarm: FakeAlarm;
  sockets: FakeSocketSource;
}

/** A `Workspace` actor as `@relaycast/actors-workspace` defines it, over the fake runtime. */
export class FakeWorkspaceActor {
  readonly sql: FakeActorDatabase;
  readonly alarm: FakeAlarm;
  readonly sockets: FakeSocketSource;
  readonly runtime: ActorRuntime;
  calls = 0;

  constructor(readonly id: string, private readonly options: Partial<ActorRuntimeOptions> = {}, state?: FakeActorState) {
    this.sql = state?.sql ?? new FakeActorDatabase();
    this.alarm = state?.alarm ?? new FakeAlarm();
    this.sockets = state?.sockets ?? new FakeSocketSource();
    this.runtime = createActorRuntime({
      sql: this.sql,
      workspaceId: id,
      baseUrl: 'https://armadillo.test',
      fileSigningSecret: FAKE_FILE_SECRET,
      outboundFetch: () => Promise.reject(new Error('no network in tests')),
      alarm: this.alarm,
      sockets: this.sockets,
      ...options,
      config: { environment: 'test', ...options.config },
    });
  }

  /**
   * The actor restarted (evicted, redeployed, stopped idle): a new runtime
   * over the same database, with the control plane still holding the sockets.
   */
  restart(): FakeWorkspaceActor {
    return new FakeWorkspaceActor(this.id, this.options, { sql: this.sql, alarm: this.alarm, sockets: this.sockets });
  }

  /**
   * One actor call: the runtime's transaction with the method body in
   * `db.transaction` as the `Workspace` actor wraps it, and the sockets
   * reachable for its duration.
   */
  private call<T>(work: () => Promise<T>): Promise<T> {
    this.calls += 1;
    return this.sockets.during(() => this.sql.atomic(() => this.sql.transaction(work)));
  }

  /**
   * One actor call, routed as the gateway does: `POST /v1/workspaces`
   * goes to `create` with the tag the gateway's keyring signs for this id.
   */
  async handle(request: ActorHttpRequest): Promise<ActorHttpResponse> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/v1/workspaces') {
      return this.create(request, await TEST_CREDENTIAL_TAGS.tag(this.id));
    }
    return this.call(() => this.runtime.handle(request));
  }

  /** A migration import step, with the tag the gateway's keyring signs for this id (one call). */
  async importData(body: unknown): Promise<ActorHttpResponse> {
    const tag = await TEST_CREDENTIAL_TAGS.tag(this.id);
    return this.call(() => this.runtime.importData(body, tag));
  }

  /** `create` with the tag the gateway hands over (one call, as `handle`). */
  create(request: ActorHttpRequest, tag: string): Promise<ActorHttpResponse> {
    return this.call(() => this.runtime.create(request, tag));
  }

  /** `onAlarm`: the firing alarm reads as set during the call and is consumed after it unless re-armed. */
  async maintain(): Promise<void> {
    const firing = this.alarm.at;
    try {
      await this.call(() => this.runtime.maintain());
    } finally {
      if (this.alarm.at === firing) this.alarm.at = null;
    }
  }

  /** `onConnect` for a socket the gateway opened with `metadata` (a grant's principal). */
  /**
   * `onConnect` with `metadata`. A signed principal is re-signed with a fresh
   * nonce and issue time (as every real upgrade gets its own grant), so tests
   * may reuse one grant for several sockets; `asIs` sends it untouched.
   */
  async connect(metadata: unknown, options: { asIs?: boolean } = {}): Promise<FakeActorSocket> {
    const parsed = options.asIs ? undefined : SocketPrincipalSchema.safeParse(metadata);
    const socket = this.sockets.connecting(parsed?.success && parsed.data.sig !== undefined ? await signSocketPrincipal(FAKE_FILE_SECRET, parsed.data) : metadata);
    await this.call(() => this.runtime.onConnect(socket));
    if (socket.state === 'connecting') socket.state = 'open';
    return socket;
  }

  /** `onMessage`: a JSON frame the client sent. */
  message(socket: FakeActorSocket, message: unknown): Promise<void> {
    return this.call(() => this.runtime.onMessage(socket, message));
  }

  /** `onDisconnect`: the control plane has already dropped the socket. */
  disconnect(socket: FakeActorSocket): Promise<void> {
    this.sockets.drop(socket);
    return this.call(() => this.runtime.onDisconnect(socket));
  }
}

export function jsonRequest(method: string, path: string, body?: unknown, token?: string): ActorHttpRequest {
  const headers: [string, string][] = [['content-type', 'application/json']];
  if (token) headers.push(['authorization', `Bearer ${token}`]);
  return {
    method,
    url: `https://armadillo.test${path}`,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  };
}
