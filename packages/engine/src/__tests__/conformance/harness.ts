import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { NodePgSession } from 'drizzle-orm/node-postgres';
import { BackgroundTasks } from '../backgroundTasks.js';
import { DurableEventQueue } from '../../adapters/node/event-queue.js';
import * as nodeContext from '../../engine/nodeContext.js';
import type { Hono } from 'hono';
import { createEngine } from '../../engine.js';
import {
  createNodeRuntime,
  createNodeRuntimeWithDb,
  type NodeRuntime,
  type NodeRuntimeWithDbOptions,
  type SqliteDbHandle,
  type EngineSocket,
} from '../../adapters/node/index.js';
import { conformancePgDb, conformancePgOwner, isConformancePgMode } from './pgMode.js';
import { drizzle as drizzleBetterSqlite } from 'drizzle-orm/better-sqlite3';
import { brandSqliteEngineDb } from '../../adapters/sqlite-handle.js';
import * as schema from '../../db/tables.js';
import type { PostgresEngineDb } from '../../adapters/postgres/engineDb.js';
import { all as sqlxAll, run as sqlxRun } from '../../db/sqlx.js';
import type { AppEnv } from '../../env.js';
import type { AdmissionHooks, EngineConfig, EngineDb } from '../../ports/index.js';
import type { TelemetrySink } from '../../ports/telemetry.js';
import type { AtomicWrite, TransactionCapability } from '../../ports/database.js';

export interface TestStack {
  app: Hono<AppEnv>;
  runtime: NodeRuntime;
  settle(): Promise<void>;
  close(): Promise<void>;
}

const stacks = new Set<TestStack>();
const contextTasks = new WeakMap<object, BackgroundTasks>();
const sendPresence = nodeContext.sendNodePresenceContext;
const presenceTrackers = new WeakSet<typeof sendPresence>();

// Presence deliberately detaches node context delivery. Observe its real promise
// at the exported boundary, including HTTP push and its final database writes.
function observePresence(): void {
  const current = nodeContext.sendNodePresenceContext;
  const implementation = vi.isMockFunction(current) ? current.getMockImplementation() : current;
  if (implementation && presenceTrackers.has(implementation)) return;
  const send = implementation ?? sendPresence;
  const tracked: typeof sendPresence = (deps, ...args) => {
    const promise = send(deps, ...args);
    return contextTasks.get(deps.db)?.track(promise) ?? promise;
  };
  presenceTrackers.add(tracked);
  vi.spyOn(nodeContext, 'sendNodePresenceContext').mockImplementation(tracked);
}

afterEach(async () => {
  await Promise.all([...stacks].map((stack) => stack.close()));
});

const PG_NO_SQLITE = 'conformance pg mode: this test needs the raw SQLite connection (runtime.handle.sqlite), which does not exist on PostgreSQL';

/**
 * PostgreSQL conformance mode: the Node runtime over this stack's own
 * PostgreSQL engine handle (built over the shared, verified pool, which the
 * setup file owns, so closing the stack leaves it open; the setup file
 * TRUNCATEs between tests).
 *
 * `runtime.handle.db` is that same handle (=== `runtime.deps.db`), so tests
 * reading and seeding rows through the bound tables (db/tables.ts) run
 * unchanged. Its static type stays the SQLite {@link SqliteDbHandle} the
 * SQLite mode returns: the query-builder surface those tests use is the
 * dialect-neutral one, and the SQLite-only terminal methods (`.all()`,
 * `.get()`, `.run()` on a builder, `db.all(sql)`) are not used by tests (use
 * `await`, {@link rawAll} and {@link rawRun}). `runtime.handle.sqlite` throws:
 * there is no SQLite connection in this mode.
 */
function pgNodeRuntime(db: PostgresEngineDb, options: NodeRuntimeWithDbOptions): NodeRuntime {
  const runtime = createNodeRuntimeWithDb(db, options, () => { closedPgHandles.add(db); });
  const handle = {
    // Documented cast: a PostgreSQL drizzle handle presented under the SQLite handle type (see above).
    db: db as unknown as SqliteDbHandle['db'],
    get sqlite(): SqliteDbHandle['sqlite'] {
      throw new Error(PG_NO_SQLITE);
    },
  } satisfies SqliteDbHandle;
  return { ...runtime, handle };
}

const closedPgHandles = new WeakSet<object>();

/**
 * Whether the stack's database is still open: SQLite's `connection.open`; on
 * PostgreSQL, whether the runtime has not yet released its handle (its
 * `closeDb` has not run; the shared pool itself stays open).
 */
export function databaseOpen(stack: TestStack): boolean {
  return pgMode ? !closedPgHandles.has(stack.runtime.deps.db) : stack.runtime.handle.sqlite.open;
}

/** True when this worker runs the conformance suite against PostgreSQL. */
export const pgMode = isConformancePgMode();

/**
 * `it` for a test that exercises SQLite-only behaviour (pragmas, backups, a
 * second SQLite file, in-process `bindSchema('sqlite')`); skipped in pg mode.
 * Every use carries a one-line reason comment.
 */
export const sqliteOnly = it.skipIf(pgMode);
/** `describe` counterpart of {@link sqliteOnly}. */
export const describeSqliteOnly = describe.skipIf(pgMode);

/** Rewrite `?` placeholders to `$1..$n` for PostgreSQL (no `?` inside string literals in test SQL). */
function placeholders(text: string, params: readonly unknown[]): SQL {
  const parts = text.split('?');
  if (parts.length - 1 !== params.length) {
    throw new Error(`raw SQL has ${parts.length - 1} placeholders but ${params.length} params`);
  }
  const chunks: SQL[] = [sql.raw(parts[0])];
  params.forEach((param, i) => {
    chunks.push(sql`${param}`, sql.raw(parts[i + 1]));
  });
  return sql.join(chunks);
}

/**
 * Run portable raw SQL with `?` placeholders on either dialect and return its
 * rows (the sqlx `all` helper; PostgreSQL bigint columns and `count(*)` arrive
 * as numbers). Unqualified table names resolve through the pool's search_path.
 */
export function rawAll<T = Record<string, unknown>>(db: object, text: string, params: readonly unknown[] = []): Promise<T[]> {
  return sqlxAll<T>(db, placeholders(text, params));
}

/** The first row of {@link rawAll}, or undefined. */
export async function rawGet<T = Record<string, unknown>>(db: object, text: string, params: readonly unknown[] = []): Promise<T | undefined> {
  return (await rawAll<T>(db, text, params))[0];
}

/** Run portable raw SQL with `?` placeholders for its effect on either dialect. */
export function rawRun(db: object, text: string, params: readonly unknown[] = []): Promise<void> {
  return sqlxRun(db, placeholders(text, params));
}

/**
 * Bulk-insert fixture rows with multi-row `INSERT ... VALUES` statements on
 * either dialect (one round trip per chunk instead of per row). `table` and
 * `columns` are trusted identifiers from test code.
 */
export async function rawInsertRows(
  db: object,
  table: string,
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): Promise<void> {
  const perChunk = Math.max(1, Math.floor(30_000 / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk);
    await rawRun(
      db,
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`,
      chunk.flat(),
    );
  }
}

/**
 * Call `before` ahead of every raw sqlx statement (`sqlx.all`/`sqlx.run`) on
 * `db`, e.g. to drive a fake per-statement clock; returns a restore function.
 * SQLite: wraps the handle's `all` (sqlx.all); PostgreSQL: wraps `execute`,
 * which both sqlx.all and sqlx.run use. Query-builder statements are not seen.
 */
export function beforeRawQuery(db: object, before: () => void): () => void {
  const key = pgMode ? 'execute' : 'all';
  const target = db as Record<string, (...args: unknown[]) => unknown>;
  const original = target[key];
  target[key] = function (this: unknown, ...args: unknown[]) {
    before();
    return original.apply(this, args);
  };
  return () => { target[key] = original; };
}

/** Booleans read back as 1/0 on SQLite and true/false on PostgreSQL; compare via this. */
export function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value !== 0 && value !== 0n;
  throw new Error(`asBool: not a boolean column value: ${String(value)}`);
}

/**
 * Install a test-only fault: a BEFORE row trigger named `name` on `table` for
 * `event` (e.g. 'UPDATE', 'INSERT', 'UPDATE OF status') that aborts the
 * statement with `message` when `when` (a trigger WHEN condition over
 * NEW/OLD, same syntax on both dialects) holds. SQLite: a trigger in the
 * stack's in-memory database (`RAISE(ABORT, ...)`), gone with the stack.
 * PostgreSQL: a plpgsql function raising `message` and its trigger, created
 * as the owner and dropped after the test (or by the returned function).
 */
export async function installFaultTrigger(
  stack: TestStack,
  spec: { name: string; table: string; event: string; message: string; when?: string },
): Promise<() => Promise<void>> {
  const { name, table, event, message } = spec;
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || !/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error('installFaultTrigger: bad identifier');
  }
  const literal = `'${message.replace(/'/g, "''")}'`;
  const when = spec.when === undefined ? '' : `WHEN ${spec.when}`;
  if (!pgMode) {
    const sqlite = stack.runtime.handle.sqlite;
    sqlite.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} ${when}
      BEGIN SELECT RAISE(ABORT, ${literal}); END`);
    return async () => { sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`); };
  }
  const owner = conformancePgOwner();
  const fn = `conformance_fault_${name}`;
  await owner.query(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION ${literal}; END $$`);
  await owner.query(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW ${spec.when === undefined ? '' : `WHEN (${spec.when})`} EXECUTE FUNCTION ${fn}()`);
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    pgFaults.delete(drop);
    await owner.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  };
  pgFaults.add(drop);
  return drop;
}

/**
 * Reject with an error whose message is the whole cause chain's messages.
 * drizzle's node-postgres session wraps a driver error as `Failed query: ...`
 * with the PostgreSQL error (e.g. a fault trigger's message) as its `cause`;
 * better-sqlite3 throws the driver error itself. Asserting on the chain keeps
 * one assertion for both dialects.
 */
export async function withCauseMessages<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    for (let e: unknown = err; e instanceof Error && !seen.has(e); e = e.cause) {
      seen.add(e);
      messages.push(e.message);
    }
    throw new Error(messages.join('\ncaused by: '), { cause: err });
  }
}

const pgFaults = new Set<() => Promise<void>>();

afterEach(async () => {
  for (const drop of [...pgFaults]) await drop();
});

/**
 * Build an engine on the Node adapter with a fast presence sweep disabled: an
 * in-memory SQLite database (or the SQLite file at `dbPath`, migrated on open,
 * so a later stack over the same path sees the same durable data), or in
 * PostgreSQL conformance mode a fresh engine handle over the shared
 * PostgreSQL pool (always durable across stacks within a test; `dbPath` is
 * ignored).
 */
export function makeNodeStack(options?: {
  dbPath?: string;
  ttlMs?: number;
  mailbox?: EngineConfig['mailbox'];
  workspaceDelivery?: EngineConfig['workspaceDelivery'];
  environment?: string;
  httpPushProxy?: EngineConfig['httpPushProxy'];
  workspaceBootstrapSecret?: string;
  workspaceBootstrapProofRequired?: boolean;
  allowWorkspaceKeyRotation?: boolean;
  internalSecret?: string;
  publicWorkspaceCreate?: boolean;
  admission?: AdmissionHooks;
  rateLimitPerMinute?: number;
  credentialFormat?: EngineConfig['credentialFormat'];
  credentialTagger?: EngineConfig['credentialTagger'];
  legacyCredentialGraceSeconds?: number;
  legacyCredentialSunset?: Date;
  telemetry?: TelemetrySink;
  maxUploadBytes?: number;
}): TestStack {
  const tasks = new BackgroundTasks();
  observePresence();
  // Blobs go to a per-stack temp dir that close() removes, not the checkout.
  // Created before any global patching so a failure here leaves nothing behind.
  const fileDir = mkdtempSync(join(tmpdir(), 'relaycast-conformance-files-'));
  // start() launches poll() before createNodeRuntime returns. Capture that exact
  // promise; calling poll() again would return early while it is already busy.
  const poll = DurableEventQueue.prototype.poll;
  DurableEventQueue.prototype.poll = function () {
    return tasks.track(poll.call(this));
  };
  let runtime: NodeRuntime;
  try {
    const runtimeOptions: NodeRuntimeWithDbOptions = {
      fileDir,
      baseUrl: 'http://localhost:0',
      config: {
        environment: options?.environment ?? 'test',
        mailbox: options?.mailbox,
        workspaceDelivery: options?.workspaceDelivery,
        httpPushProxy: options?.httpPushProxy,
        // An explicit `workspaceBootstrapSecret: undefined` runs unconfigured.
        workspaceBootstrapSecret: options && 'workspaceBootstrapSecret' in options
          ? options.workspaceBootstrapSecret
          : 'test-bootstrap-secret',
        workspaceBootstrapProofRequired: options?.workspaceBootstrapProofRequired,
        allowWorkspaceKeyRotation: options?.allowWorkspaceKeyRotation,
        internalSecret: options?.internalSecret,
        publicWorkspaceCreate: options?.publicWorkspaceCreate,
        rateLimitPerMinute: options?.rateLimitPerMinute,
        credentialFormat: options?.credentialFormat,
        credentialTagger: options?.credentialTagger,
        legacyCredentialGraceSeconds: options?.legacyCredentialGraceSeconds,
        legacyCredentialSunset: options?.legacyCredentialSunset,
        maxUploadBytes: options?.maxUploadBytes,
      },
      admission: options?.admission,
      telemetry: options?.telemetry,
      // Disable the auto-sweep timer; tests drive presence.sweep() explicitly.
      eventQueue: { pollIntervalMs: 0 },
      presence: { ttlMs: options?.ttlMs ?? 60_000, sweepIntervalMs: 0 },
    };
    const pgDb = conformancePgDb();
    runtime = pgDb
      ? pgNodeRuntime(pgDb, runtimeOptions)
      : createNodeRuntime({ ...runtimeOptions, dbPath: options?.dbPath ?? ':memory:', migrate: true });
  } catch (err) {
    rmSync(fileDir, { recursive: true, force: true });
    throw err;
  } finally {
    DurableEventQueue.prototype.poll = poll;
  }
  contextTasks.set(runtime.deps.db, tasks);
  let app: Hono<AppEnv>;
  try {
    const queuePoll = runtime.webhookQueue.poll.bind(runtime.webhookQueue);
    runtime.webhookQueue.poll = () => tasks.track(queuePoll());
    const drainNode = runtime.realtime.drainNode.bind(runtime.realtime);
    runtime.realtime.drainNode = (...args) => tasks.track(drainNode(...args));
    // presenceRefresh fires the request's heartbeat without awaiting it; its
    // presence broadcast (a durable event append) must still settle. Tracked
    // without its rejection, which that middleware deliberately swallows.
    const heartbeat = runtime.presence.heartbeat.bind(runtime.presence);
    runtime.presence.heartbeat = (...args) => {
      const promise = heartbeat(...args);
      void tasks.track(promise.catch(() => {}));
      return promise;
    };
    app = createEngine(runtime.deps);
    tasks.bind(app);
  } catch (err) {
    // No stack is registered yet, so close() would never run: release here.
    try {
      runtime.close();
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
    throw err;
  }
  let closing: Promise<void> | undefined;
  const stack: TestStack = {
    app, runtime,
    settle: () => tasks.drain(),
    close: () => closing ??= (async () => {
      runtime.webhookQueue.stop();
      runtime.presence.stop();
      try {
        await tasks.drain();
      } finally {
        try {
          runtime.close();
        } finally {
          stacks.delete(stack);
          rmSync(fileDir, { recursive: true, force: true });
        }
      }
    })(),
  };
  stacks.add(stack);
  return stack;
}

/** A capturing EngineSocket for asserting realtime delivery without a network. */
export class FakeSocket implements EngineSocket {
  readonly received: Record<string, unknown>[] = [];
  closed = false;
  send(data: string): void {
    this.received.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  /** Events of a given `type`. */
  ofType(type: string): Record<string, unknown>[] {
    return this.received.filter((e) => e.type === type);
  }
}

interface CreatedWorkspace {
  workspaceKey: string;
  workspaceId: string;
}

/** Create a workspace via the HTTP API and return its key + id. */
export async function createWorkspace(app: Hono<AppEnv>, name: string): Promise<CreatedWorkspace> {
  const res = await app.request('/v1/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (res.status >= 300) {
    throw new Error(`createWorkspace failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data?: { id?: string; workspace_id?: string; api_key?: string; key?: string };
  };
  const data = body.data ?? {};
  const workspaceId = data.workspace_id ?? data.id ?? '';
  const workspaceKey = data.api_key ?? data.key ?? '';
  return { workspaceKey, workspaceId };
}

interface CreatedAgent {
  token: string;
  agentId: string;
  name: string;
}

/** Register an agent via the HTTP API and return its token + id. */
export async function registerAgent(app: Hono<AppEnv>, workspaceKey: string, name: string): Promise<CreatedAgent> {
  const res = await app.request('/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({ name }),
  });
  if (res.status >= 300) {
    throw new Error(`registerAgent failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: { id?: string; token?: string; agent_token?: string } };
  const data = body.data ?? {};
  return { token: data.token ?? data.agent_token ?? '', agentId: data.id ?? '', name };
}

export async function attachDirectNodeSocket(
  stack: TestStack,
  workspaceId: string,
  agent: CreatedAgent,
): Promise<{ sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void>; handleClose(): Promise<void> }; nodeId: string }> {
  const nodeId = `node_direct_${agent.agentId}`;
  const sock = new FakeSocket();
  const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, nodeId, sock);
  await handle.handleMessage(JSON.stringify({
    v: 1,
    id: `test-direct-${agent.agentId}`,
    type: 'node.register',
    node_id: nodeId,
    name: `direct-${agent.agentId}`,
    capabilities: [],
    max_agents: 1,
    tags: ['implicit', 'direct', 'test'],
    version: 'test-direct-node',
    resume_cursor: null,
  }));
  return { sock, handle, nodeId };
}

export function deliverFramesOfType(sock: FakeSocket, type: string): Record<string, unknown>[] {
  return sock.ofType('deliver').filter((frame) => {
    const payload = frame.payload;
    return !!payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).type === type;
  });
}

export function contextUpdatesOfType(sock: FakeSocket, event: string): Record<string, unknown>[] {
  return sock.ofType('context.update').filter((frame) => frame.event === event);
}

/**
 * Wrap a built statement so it fails when *executed* (awaited), not when built.
 * Write paths build their statement list up front, so a build-time throw would
 * abort before any write executes and never exercise rollback or compensation;
 * an execution-time failure lands mid-transaction / mid-batch / mid-sequence —
 * the crash the atomicity machinery exists for. Builder chaining and `toSQL()`
 * still delegate to the real statement.
 */
export function failOnExecute<T extends object>(target: T, message: string): T {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          Promise.reject(new Error(message)).then(onFulfilled, onRejected);
      }
      const value = Reflect.get(obj, prop) as unknown;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
          return result && typeof result === 'object' ? failOnExecute(result as object, message) : result;
        };
      }
      return value;
    },
  });
}

/**
 * Run `before` (e.g. a racing write through another statement) when `target`
 * — a drizzle builder, followed through its chained calls — is awaited, then
 * execute it. The async counterpart of a synchronous raw write inside a spy,
 * so a race lands between a read and the CAS write on either dialect.
 */
export function runBeforeExecute<T extends object>(target: T, before: () => Promise<unknown>): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop) as unknown;
      if (prop === 'then' && typeof value === 'function') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
          before().then(() => (value as PromiseLike<unknown>['then']).call(obj, onFulfilled, onRejected), onRejected);
      }
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
          return result && typeof result === 'object' ? runBeforeExecute(result as object, before) : result;
        };
      }
      return value;
    },
  });
}

/**
 * A view of `db` whose builder statements (select/insert/update/delete and raw
 * `execute`/`all`/`run`) await `gate()` before they execute. Lets a synchronous
 * spy start an async racing write (see {@link rawRun}) that must land before the
 * code under test's next statement: on SQLite the raw write already ran
 * synchronously, on PostgreSQL the gate holds the next statement until it
 * commits. Transactions opened through the view are not gated.
 */
export function gateStatements<T extends object>(db: T, gate: () => Promise<unknown>): T {
  const builders = new Set(['select', 'selectDistinct', 'insert', 'update', 'delete']);
  const raw = new Set(['execute', 'all', 'get', 'run', 'values']);
  return new Proxy(db, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      if (builders.has(prop)) {
        return (...args: unknown[]) =>
          runBeforeExecute((value as (...a: unknown[]) => object).apply(obj, args), gate);
      }
      if (raw.has(prop)) {
        return async (...args: unknown[]) => {
          await gate();
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      return value;
    },
  });
}

/**
 * Aim a failure at one statement when a write path touches the same table more
 * than once. The counter advances per *built* statement and every path builds
 * in execution order, so `{ skip: 1 }` spares the first and fails the second.
 * `times` bounds how many fail: `{ times: 1 }` is a one-shot outage, which is
 * what a compensating write issued from the same path has to survive.
 */
export interface InjectFailureOptions { skip?: number; times?: number }

function injectBuilderFailure(
  db: EngineDb,
  verb: 'insert' | 'update',
  table: unknown,
  message: string,
  options: InjectFailureOptions,
): () => void {
  type Handle = Record<'insert' | 'update', (t: unknown) => object>;
  const skip = options.skip ?? 0;
  const times = options.times ?? Number.POSITIVE_INFINITY;
  let built = 0;
  const patch = (target: object) => {
    const handle = target as Handle;
    const real = handle[verb].bind(target);
    handle[verb] = (t: unknown) => {
      const builder = real(t);
      if (t !== table) return builder;
      const index = built++;
      return index >= skip && index < skip + times ? failOnExecute(builder, message) : builder;
    };
    return () => { handle[verb] = real; };
  };
  const restore = patch(db);
  // PostgreSQL's withTransaction hands the callback a separate drizzle
  // transaction handle, so its builders get the same injection (and share
  // the skip/times count). SQLite's transactional writes reach `db` itself.
  const capability = db as Partial<TransactionCapability>;
  const withTransaction = capability.withTransaction;
  if (!pgMode || !withTransaction) return restore;
  capability.withTransaction = <T>(fn: (tx: EngineDb) => Promise<T>) =>
    withTransaction.call(db, (tx: EngineDb) => { patch(tx); return fn(tx); }) as Promise<T>;
  return () => { restore(); capability.withTransaction = withTransaction; };
}

/** Make statements inserting into `table` fail at execution; returns a restore function. */
export function injectInsertFailure(
  db: EngineDb, table: unknown, message: string, options: InjectFailureOptions = {},
): () => void {
  return injectBuilderFailure(db, 'insert', table, message, options);
}

/** Make statements updating `table` fail at execution; returns a restore function. */
export function injectUpdateFailure(
  db: EngineDb, table: unknown, message: string, options: InjectFailureOptions = {},
): () => void {
  return injectBuilderFailure(db, 'update', table, message, options);
}

/**
 * A second handle on the stack's database with neither interactive
 * transactions nor batch, like D1 without batch: a failed write in a
 * multi-statement path is not rolled back. SQLite: a bare drizzle handle on the
 * same connection; PostgreSQL: a fresh handle on the shared pool with
 * `withTransaction` removed.
 */
export function nonTransactionalHandle(stack: TestStack): EngineDb {
  if (!pgMode) return brandSqliteEngineDb(drizzleBetterSqlite(stack.runtime.handle.sqlite, { schema }));
  const db: EngineDb = conformancePgDb()!;
  stripTransactionCapability(db);
  return db;
}

/** Drop the interactive-transaction capability, as the D1 handle never has it. */
export function stripTransactionCapability(db: EngineDb): void {
  delete (db as Partial<TransactionCapability>).withTransaction;
}

/**
 * Turn the Node handle into a D1-shaped one: no `withTransaction`, but a
 * `batch()` that executes every statement inside one underlying SQLite
 * transaction (all-or-nothing, like D1) and records each batch's SQL.
 */
export function attachFakeBatch(
  stack: TestStack,
  db: EngineDb,
  beforeExecute?: () => Promise<void>,
): string[][] {
  stripTransactionCapability(db);
  const batches: string[][] = [];
  type Statement = AtomicWrite & { toSQL(): { sql: string } };
  if (pgMode) {
    // PostgreSQL: one drizzle transaction on the stack's own handle (the
    // stripped capability only removed `withTransaction`). The statements
    // were built from `db`, so each executes on the transaction's session:
    // drizzle builders by rebinding their `session`, sqlx raw writes (no
    // session) through `tx.execute` of their SQL.
    const pgDb = db as unknown as PostgresEngineDb;
    (db as unknown as Record<string, unknown>).batch = async (statements: ReadonlyArray<Statement>): Promise<unknown[]> => {
      batches.push(statements.map((s) => s.toSQL().sql));
      await beforeExecute?.();
      return pgDb.transaction(async (tx) => {
        const session = (tx as unknown as { session: unknown }).session;
        const results: unknown[] = [];
        for (const statement of statements) {
          const target = statement as unknown as { session?: unknown };
          if (target.session !== undefined) {
            target.session = session;
            results.push(await statement);
          } else {
            results.push(await tx.execute(statement.getSQL()));
          }
        }
        return results;
      });
    };
    return batches;
  }
  const sqlite = stack.runtime.handle.sqlite;
  (db as unknown as Record<string, unknown>).batch = async (statements: ReadonlyArray<Statement>): Promise<unknown[]> => {
    batches.push(statements.map((s) => s.toSQL().sql));
    await beforeExecute?.();
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results: unknown[] = [];
      for (const statement of statements) {
        results.push(await statement);
      }
      sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
  };
  return batches;
}

/**
 * Run `before` (a racing write) ahead of every atomic write batch of `db`, on
 * either dialect. SQLite: the D1 shape, {@link attachFakeBatch} with `before`
 * as its pre-execute hook. PostgreSQL: ahead of each `withTransaction`, which
 * the engine requires there (sequence-allocating writes refuse a batch
 * without one), so the race lands between selection and commit the same way.
 */
export function beforeAtomicWrites(stack: TestStack, db: EngineDb, before: () => Promise<void>): void {
  if (!pgMode) {
    attachFakeBatch(stack, db, before);
    return;
  }
  const capability = db as Partial<TransactionCapability>;
  const withTransaction = capability.withTransaction;
  if (!withTransaction) throw new Error('beforeAtomicWrites: the PostgreSQL handle has no withTransaction');
  capability.withTransaction = async <T>(fn: (tx: EngineDb) => Promise<T>) => {
    await before();
    return withTransaction.call(db, fn) as Promise<T>;
  };
}

/** Cloudflare D1's per-statement bound-parameter ceiling. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Observe (and optionally fail) every statement the stack's database handle
 * prepares, on either dialect; returns a restore function. `hook` receives
 * the SQL text and its bound-parameter count, and may throw to fail that
 * statement before it runs. SQLite: wraps the connection's `prepare`.
 * PostgreSQL: wraps drizzle's node-postgres `prepareQuery` for sessions of
 * this stack's handle (its transactions included), strips the schema
 * qualifier and spells `$n` placeholders as `?`, so `update "deliveries"`
 * and `"id" in (?)` match on both dialects. `params` carries the bound
 * values on PostgreSQL only (SQLite binds them after `prepare`).
 */
export function interceptStatements(
  stack: TestStack,
  hook: (sql: string, parameterCount: number, params?: readonly unknown[]) => void,
): () => void {
  if (!pgMode) {
    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((source: string) => {
      hook(source, source.match(/\?/g)?.length ?? 0);
      return originalPrepare(source);
    }) as typeof sqlite.prepare;
    return () => { sqlite.prepare = originalPrepare as typeof sqlite.prepare; };
  }
  const dialect = (stack.runtime.deps.db as unknown as { dialect: unknown }).dialect;
  const proto = NodePgSession.prototype as unknown as {
    prepareQuery: (this: { dialect: unknown }, query: { sql: string; params: unknown[] }, ...rest: unknown[]) => unknown;
  };
  const original = proto.prepareQuery;
  const wrapped: typeof original = function (query, ...rest) {
    if (this.dialect === dialect) hook(portableSql(query.sql), query.params.length, query.params);
    return original.call(this, query, ...rest);
  };
  proto.prepareQuery = wrapped;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (proto.prepareQuery === wrapped) proto.prepareQuery = original;
    statementRestores.delete(restore);
  };
  statementRestores.add(restore);
  return restore;
}

const statementRestores = new Set<() => void>();

/**
 * PostgreSQL statement text in the SQLite spelling the hooks match on:
 * `$n` placeholders as `?` (tables live in `public`, so drizzle emits no schema
 * qualifier).
 */
function portableSql(text: string): string {
  return text.replace(/\$\d+\b/g, '?');
}

afterEach(() => {
  // Unwind in reverse so stacked interceptors restore the real method last.
  for (const restore of [...statementRestores].reverse()) restore();
});

/**
 * D1's per-statement bound-parameter ceiling, enforced at statement
 * preparation on either dialect (better-sqlite3 and PostgreSQL both accept
 * far more), so a regression cannot pass locally while still failing in
 * production.
 */
export function enforceD1ParameterLimit(stack: TestStack): {
  maxObserved: () => number;
  restore: () => void;
} {
  let maxObserved = 0;
  const restore = interceptStatements(stack, (_source, parameterCount) => {
    maxObserved = Math.max(maxObserved, parameterCount);
    if (parameterCount > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(
        `D1_ERROR: too many SQL variables (${parameterCount}; maximum ${D1_MAX_BOUND_PARAMETERS}): SQLITE_ERROR`,
      );
    }
  });
  return { maxObserved: () => maxObserved, restore };
}

/**
 * Report how many rows each execution of a statement whose SQL matches
 * `match` returned from the database (before any JS post-processing), on
 * either dialect. SQLite: counts better-sqlite3 `statement.all` results.
 * PostgreSQL: counts the rows of drizzle's prepared-query result. The
 * reported SQL is spelled as in {@link interceptStatements}; params are
 * the statement's bound values.
 */
export function observeStatementRows(
  stack: TestStack,
  match: RegExp,
  onRows: (sql: string, rows: number, params: unknown[]) => void,
): () => void {
  if (!pgMode) {
    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((source: string) => {
      const statement = originalPrepare(source);
      if (match.test(source)) {
        const all = statement.all.bind(statement);
        statement.all = ((...params: unknown[]) => {
          const rows = all(...params);
          onRows(source, rows.length, params);
          return rows;
        }) as typeof statement.all;
      }
      return statement;
    }) as typeof sqlite.prepare;
    return () => { sqlite.prepare = originalPrepare as typeof sqlite.prepare; };
  }
  const dialect = (stack.runtime.deps.db as unknown as { dialect: unknown }).dialect;
  const proto = NodePgSession.prototype as unknown as {
    prepareQuery: (this: { dialect: unknown }, query: { sql: string; params: unknown[] }, ...rest: unknown[]) => unknown;
  };
  const original = proto.prepareQuery;
  const wrapped: typeof original = function (query, ...rest) {
    const prepared = original.call(this, query, ...rest) as { execute: (...args: unknown[]) => Promise<unknown> };
    const source = portableSql(query.sql);
    if (this.dialect === dialect && match.test(source)) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async (...args: unknown[]) => {
        const result = await execute(...args);
        const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] } | undefined)?.rows;
        if (Array.isArray(rows)) onRows(source, rows.length, query.params);
        return result;
      };
    }
    return prepared;
  };
  proto.prepareQuery = wrapped;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (proto.prepareQuery === wrapped) proto.prepareQuery = original;
    statementRestores.delete(restore);
  };
  statementRestores.add(restore);
  return restore;
}

/**
 * Make the stack's database reject every write, including zero-row UPDATEs.
 * SQLite: `PRAGMA query_only = ON`. PostgreSQL: the engine's statements are
 * checked before execution and anything other than a read (or transaction
 * control) throws, since a pooled connection cannot be made read-only for
 * the whole runtime.
 */
export function rejectWrites(stack: TestStack): void {
  if (!pgMode) {
    stack.runtime.handle.sqlite.pragma('query_only = ON');
    return;
  }
  interceptStatements(stack, (source) => {
    const text = source.trim().toLowerCase();
    const control = /^(begin|commit|rollback|savepoint|release|set|show)\b/.test(text);
    const read = /^(select|with)\b/.test(text) && !/\b(insert|update|delete|merge)\b/.test(text.replace(/'[^']*'/g, "''"));
    if (!control && !read) throw new Error(`attempt to write a readonly database: ${source.slice(0, 120)}`);
  });
}

/**
 * Apply raw writes (`?` placeholders) from a synchronous engine hook so they
 * land before the engine's next statement, on either dialect. Several
 * statements run as one transaction.
 *
 * SQLite: executed immediately on the stack's connection, as the hook's own
 * inline `sqlite.prepare(...).run()` did. PostgreSQL: a hook cannot await, so
 * the statements run as the owner in one transaction while every later
 * statement of the stack's database waits for that commit (fails after 10s
 * rather than hanging if the engine itself holds a conflicting lock).
 * `unixepoch()` is rewritten to the migrations-pg equivalent.
 */
export function writeFromSyncHook(stack: TestStack, statements: ReadonlyArray<readonly [string, readonly unknown[]?]>): void {
  if (!pgMode) {
    const sqlite = stack.runtime.handle.sqlite;
    const apply = () => {
      for (const [text, params = []] of statements) sqlite.prepare(text).run(...params);
    };
    if (statements.length > 1) sqlite.transaction(apply)();
    else apply();
    return;
  }
  const owner = conformancePgOwner();
  const write = (async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const [text, params = []] of statements) {
        let n = 0;
        const pgText = text
          .replaceAll('unixepoch()', 'floor(extract(epoch from statement_timestamp()))::bigint')
          .replace(/\?/g, () => `$${++n}`);
        await client.query(pgText, [...params]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.race([
    write,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('writeFromSyncHook: write blocked for 10s (engine lock held?)')), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  settled.catch(() => {});
  const dialect = (stack.runtime.deps.db as unknown as { dialect: unknown }).dialect;
  const proto = NodePgSession.prototype as unknown as {
    prepareQuery: (this: { dialect: unknown }, query: { sql: string; params: unknown[] }, ...rest: unknown[]) => unknown;
  };
  const original = proto.prepareQuery;
  const wrapped: typeof original = function (query, ...rest) {
    const prepared = original.call(this, query, ...rest) as { execute: (...args: unknown[]) => Promise<unknown> };
    if (this.dialect === dialect) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async (...args: unknown[]) => {
        await settled;
        return execute(...args);
      };
    }
    return prepared;
  };
  proto.prepareQuery = wrapped;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (proto.prepareQuery === wrapped) proto.prepareQuery = original;
    statementRestores.delete(restore);
  };
  statementRestores.add(restore);
  void settled.then(restore, () => {});
}
